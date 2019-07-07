"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const matrix_appservice_bridge_1 = require("matrix-appservice-bridge");
const Datastore = require("nedb");
const path = require("path");
const randomstring = require("randomstring");
const rp = require("request-promise-native");
const OAuth2_1 = require("./OAuth2");
const BridgedRoom_1 = require("./BridgedRoom");
const SlackGhost_1 = require("./SlackGhost");
const MatrixUser_1 = require("./MatrixUser");
const SlackHookHandler_1 = require("./SlackHookHandler");
const AdminCommands_1 = require("./AdminCommands");
const Provisioning = require("./Provisioning");
const log = matrix_appservice_bridge_1.Logging.get("Main");
const RECENT_EVENTID_SIZE = 20;
class Main {
    constructor(config) {
        this.config = config;
        this.oauth2 = null;
        this.teams = new Map();
        this.recentMatrixEventIds = new Array(RECENT_EVENTID_SIZE);
        this.mostRecentEventIdIdx = 0;
        this.rooms = [];
        this.roomsBySlackChannelId = {};
        this.roomsBySlackTeamId = {};
        this.roomsByMatrixRoomId = {};
        this.roomsByInboundId = {};
        this.ghostsByUserId = {};
        this.matrixUsersById = {};
        // TODO(paul): ugh. this.getBotIntent() doesn't work before .run time
        // So we can't create the StateLookup instance yet
        this.stateStorage = null;
        this.teamDatastore = null;
        this.adminCommands = new AdminCommands_1.AdminCommands(this);
        if (config.oauth2) {
            this.oauth2 = new OAuth2_1.OAuth2({
                main: this,
                client_id: config.oauth2.client_id,
                client_secret: config.oauth2.client_secret,
                redirect_prefix: config.oauth2.redirect_prefix || config.inbound_uri_prefix,
            });
        }
        const dbdir = config.dbdir || "";
        this.bridge = new matrix_appservice_bridge_1.Bridge({
            homeserverUrl: config.homeserver.url,
            domain: config.homeserver.server_name,
            registration: "slack-registration.yaml",
            userStore: path.join(dbdir, "user-store.db"),
            roomStore: path.join(dbdir, "room-store.db"),
            eventStore: path.join(dbdir, "event-store.db"),
            controller: {
                onUserQuery: () => ({}),
                onEvent: (request) => {
                    const ev = request.getData();
                    this.stateStorage.onEvent(ev);
                    this.onMatrixEvent(ev);
                },
            }
        });
        this.slackHookHandler = new SlackHookHandler_1.SlackHookHandler(this);
        if (config.enable_metrics) {
            this.initialiseMetrics();
        }
    }
    get eventStore() {
        return this.bridge.getEventStore();
    }
    get roomStore() {
        return this.bridge.getRoomStore();
    }
    get userStore() {
        return this.bridge.getUserStore();
    }
    get botIntent() {
        return this.bridge.getIntent();
    }
    getIntent(userId) {
        return this.bridge.getIntent(userId);
    }
    get userIdPrefix() {
        return this.config.username_prefix;
    }
    get allRooms() {
        return Array.from(this.rooms);
    }
    get botUserId() {
        return this.bridge.getBot().userId();
    }
    initialiseMetrics() {
        this.metrics = this.bridge.getPrometheusMetrics();
        this.bridge.registerBridgeGauges(() => {
            const now = Date.now() / 1000;
            const remote_rooms_by_age = new matrix_appservice_bridge_1.PrometheusMetrics.AgeCounters();
            const matrix_rooms_by_age = new matrix_appservice_bridge_1.PrometheusMetrics.AgeCounters();
            this.rooms.forEach((room) => {
                remote_rooms_by_age.bump(now - room.RemoteATime);
                matrix_rooms_by_age.bump(now - room.MatrixATime);
            });
            const count_ages = (users) => {
                var counts = new matrix_appservice_bridge_1.PrometheusMetrics.AgeCounters();
                Object.keys(users).forEach((id) => {
                    counts.bump(now - users[id].aTime);
                });
                return counts;
            };
            return {
                matrixRoomConfigs: Object.keys(this.roomsByMatrixRoomId).length,
                remoteRoomConfigs: Object.keys(this.roomsByInboundId).length,
                // As a relaybot we don't create remote-side ghosts
                remoteGhosts: 0,
                matrixRoomsByAge: matrix_rooms_by_age,
                remoteRoomsByAge: remote_rooms_by_age,
                matrixUsersByAge: count_ages(this.matrixUsersById),
                remoteUsersByAge: count_ages(this.ghostsByUserId),
            };
        });
        this.metrics.addCounter({
            name: "received_messages",
            help: "count of received messages",
            labels: ["side"],
        });
        this.metrics.addCounter({
            name: "sent_messages",
            help: "count of sent messages",
            labels: ["side"],
        });
        this.metrics.addCounter({
            name: "remote_api_calls",
            help: "Count of the number of remote API calls made",
            labels: ["method"],
        });
        this.metrics.addTimer({
            name: "matrix_request_seconds",
            help: "Histogram of processing durations of received Matrix messages",
            labels: ["outcome"],
        });
        this.metrics.addTimer({
            name: "remote_request_seconds",
            help: "Histogram of processing durations of received remote messages",
            labels: ["outcome"],
        });
    }
    incCounter(name, labels = {}) {
        if (!this.metrics)
            return;
        this.metrics.incCounter(name, labels);
    }
    incRemoteCallCounter(type) {
        if (!this.metrics)
            return;
        this.metrics.incCounter("remote_api_calls", { method: type });
    }
    startTimer(name, labels = {}) {
        if (!this.metrics)
            return function () { };
        return this.metrics.startTimer(name, labels);
    }
    putRoomToStore(room) {
        const entry = room.toEntry();
        return this.roomStore.upsert({ id: entry.id }, entry);
    }
    putUserToStore(user) {
        const entry = user.toEntry();
        return this.userStore.upsert({ id: entry.id }, entry);
    }
    getUrlForMxc(mxc_url) {
        const hs = this.config.homeserver;
        return (hs.media_url || hs.url) + "/_matrix/media/r0/download/" +
            mxc_url.substring("mxc://".length);
    }
    async getTeamDomainForMessage(message) {
        if (message.team_domain) {
            return message.team_domain;
        }
        if (!message.team_id) {
            throw "Cannot determine team, no id given.";
        }
        if (this.teams.has(message.team_id)) {
            return this.teams.get(message.team_id).domain;
        }
        const room = this.getRoomBySlackChannelId(message.channel);
        if (!room) {
            log.error("Couldn't find channel in order to get team domain");
            return;
        }
        var channelsInfoApiParams = {
            uri: 'https://slack.com/api/team.info',
            qs: {
                token: room.AccessToken
            },
            json: true
        };
        this.incRemoteCallCounter("team.info");
        const response = await rp(channelsInfoApiParams);
        if (!response.ok) {
            log.error(`Trying to fetch the ${message.team_id} team.`, response);
            return;
        }
        log.info("Got new team:", response);
        this.teams.set(message.team_id, response.team);
        return response.team.domain;
    }
    getUserId(id, teamDomain) {
        return `@${this.userIdPrefix}${teamDomain.toLowerCase()}_${id.toUpperCase()}:${this.config.homeserver.server_name}`;
    }
    async getGhostForSlackMessage(message) {
        // Slack ghost IDs need to be constructed from user IDs, not usernames,
        // because users can change their names
        // TODO if the team_domain is changed, we will recreate all users.
        // TODO(paul): Steal MatrixIdTemplate from matrix-appservice-gitter
        // team_domain is gone, so we have to actually get the domain from a friendly object.
        const teamDomain = (await this.getTeamDomainForMessage(message)).toLowerCase();
        const userId = this.getUserId(message.user_id.toUpperCase(), teamDomain);
        if (this.ghostsByUserId[userId]) {
            log.debug("Getting existing ghost from cache for", userId);
            return this.ghostsByUserId[userId];
        }
        const intent = this.bridge.getIntent(userId);
        const entries = await this.userStore.select({ id: userId });
        let ghost;
        if (entries.length) {
            log.debug("Getting existing ghost for", userId);
            ghost = SlackGhost_1.SlackGhost.fromEntry(this, entries[0], intent);
        }
        else {
            log.debug("Creating new ghost for", userId);
            ghost = new SlackGhost_1.SlackGhost(this, userId, undefined, undefined, intent);
            this.putUserToStore(ghost);
        }
        this.ghostsByUserId[userId] = ghost;
        return ghost;
    }
    getOrCreateMatrixUser(id) {
        let u = this.matrixUsersById[id];
        if (u) {
            return u;
        }
        u = this.matrixUsersById[id] = new MatrixUser_1.MatrixUser(this, { user_id: id });
        return u;
    }
    genInboundId() {
        let attempts = 10;
        while (attempts > 0) {
            const id = randomstring.generate(32);
            if (!(id in this.roomsByInboundId))
                return id;
            attempts--;
        }
        // Prevent tightlooping if randomness goes odd
        throw Error("Failed to generate a unique inbound ID after 10 attempts");
    }
    addBridgedRoom(room) {
        this.rooms.push(room);
        if (room.SlackChannelId) {
            this.roomsBySlackChannelId[room.SlackChannelId] = room;
        }
        if (room.InboundId) {
            this.roomsByInboundId[room.InboundId] = room;
        }
        if (room.SlackTeamId) {
            if (this.roomsBySlackTeamId[room.SlackTeamId]) {
                this.roomsBySlackTeamId[room.SlackTeamId].push(room);
            }
            else {
                this.roomsBySlackTeamId[room.SlackTeamId] = [room];
            }
        }
    }
    removeBridgedRoom(room) {
        this.rooms = this.rooms.filter((r) => r !== room);
        if (room.SlackChannelId) {
            delete this.roomsBySlackChannelId[room.SlackChannelId];
        }
        if (room.InboundId) {
            delete this.roomsByInboundId[room.InboundId];
        }
        // XXX: We don't remove it from this.roomsBySlackTeamId?
    }
    getRoomBySlackChannelId(channelId) {
        return this.roomsBySlackChannelId[channelId];
    }
    getRoomsBySlackTeamId(channelId) {
        return this.roomsBySlackTeamId[channelId] || [];
    }
    getRoomBySlackChannelName(channelName) {
        // TODO(paul): this gets inefficient for long lists
        for (const room of this.rooms) {
            if (room.SlackChannelName === channelName) {
                return room;
            }
        }
        return null;
    }
    getRoomByMatrixRoomId(roomId) {
        return this.roomsByMatrixRoomId[roomId];
    }
    getRoomByInboundId(inboundId) {
        return this.roomsByInboundId[inboundId];
    }
    getInboundUrlForRoom(room) {
        return this.config.inbound_uri_prefix + room.getInboundId();
    }
    getStoredEvent(roomId, eventType, stateKey) {
        return this.stateStorage.getState(roomId, eventType, stateKey);
    }
    async getState(roomId, eventType) {
        //   TODO: handle state_key. Has different return shape in the two cases
        const cachedEvent = this.getStoredEvent(roomId, eventType);
        if (cachedEvent && cachedEvent.length) {
            // StateLookup returns entire state events. client.getStateEvent returns
            //   *just the content*
            return cachedEvent[0].content;
        }
        return this.botIntent.client.getStateEvent(roomId, eventType);
    }
    async listAllUsers(roomId) {
        const members = await this.bridge.getBot().getJoinedMembers(roomId);
        return Object.keys(members);
    }
    async listGhostUsers(roomId) {
        const userIds = await this.listAllUsers(roomId);
        const regexp = new RegExp("^@" + this.config.username_prefix);
        return userIds.filter((i) => i.match(regexp));
    }
    async drainAndLeaveMatrixRoom(roomId) {
        const userIds = await this.listGhostUsers(roomId);
        log.info("Draining " + userIds.length + " ghosts from " + roomId);
        const promises = [];
        for (const userId of userIds) {
            promises.push(this.getIntent(userId).leave(roomId));
        }
        await Promise.all(promises);
        await this.botIntent.leave(roomId);
    }
    async listRoomsFor() {
        return this.bridge.getBot().getJoinedRooms();
    }
    async onMatrixEvent(ev) {
        // simple de-dup
        const recents = this.recentMatrixEventIds;
        for (let i = 0; i < recents.length; i++) {
            if (recents[i] != undefined && recents[i] == ev.ev_id) {
                // move the most recent ev to where we found a dup and add the
                // duplicate at the end (reasoning: we only want one of the
                // duplicated ev_id in the list, but we want it at the end)
                recents[i] = recents[this.mostRecentEventIdIdx];
                recents[this.mostRecentEventIdIdx] = ev.ev_id;
                log.warn("Ignoring duplicate ev: " + ev.ev_id);
                return;
            }
        }
        this.mostRecentEventIdIdx = (this.mostRecentEventIdIdx + 1) % 20;
        recents[this.mostRecentEventIdIdx] = ev.ev_id;
        this.incCounter("received_messages", { side: "matrix" });
        const endTimer = this.startTimer("matrix_request_seconds");
        const myUserId = this.bridge.getBot().getUserId();
        if (ev.type === "m.room.member" && ev.state_key === myUserId) {
            // A membership event about myself
            const membership = ev.content.membership;
            if (membership === "invite") {
                // Automatically accept all invitations
                // NOTE: This can race and fail if the invite goes down the AS stream
                // before the homeserver believes we can actually join the room.
                await this.botIntent.join(ev.room_id);
            }
            endTimer({ outcome: "success" });
            return;
        }
        if (ev.type === "m.room.member"
            && this.bridge.getBot().isRemoteUser(ev.state_key)
            && ev.sender !== myUserId) {
            log.info(`${ev.state_key} got invite for ${ev.room_id} but we can't do DMs, warning room.`);
            const intent = this.getIntent(ev.state_key);
            try {
                await intent.join(ev.room_id);
                await intent.sendEvent(ev.room_id, "m.room.message", {
                    msgtype: "m.notice",
                    body: "The slack bridge doesn't support private messaging, or inviting to rooms.",
                });
            }
            catch (err) {
                log.error("Couldn't send warning to user(s) about not supporting PMs", err);
            }
            await intent.leave(ev.room_id);
            endTimer({ outcome: "success" });
            return;
        }
        if (ev.sender === myUserId) {
            endTimer({ outcome: "success" });
            return;
        }
        if (this.config.matrix_admin_room && ev.room_id === this.config.matrix_admin_room) {
            try {
                await this.onMatrixAdminMessage(ev);
            }
            catch (e) {
                log.error("Failed processing admin message: ", e);
                endTimer({ outcome: "fail" });
                return;
            }
            endTimer({ outcome: "success" });
            return;
        }
        const room = this.getRoomByMatrixRoomId(ev.room_id);
        if (!room) {
            log.warn("Ignoring ev for matrix room with unknown slack channel:" +
                ev.room_id);
            endTimer({ outcome: "dropped" });
            return;
        }
        // Handle a m.room.redaction event
        if (ev.type === "m.room.redaction") {
            try {
                await room.onMatrixRedaction(ev);
            }
            catch (e) {
                log.error("Failed procesing matrix message: ", e);
                endTimer({ outcome: "fail" });
                return;
            }
            endTimer({ outcome: "success" });
            return;
        }
        // Handle a m.room.message event
        if (ev.type === "m.room.message" || ev.content) {
            if (ev.content['m.relates_to'] !== undefined) {
                const relates_to = ev.content['m.relates_to'];
                if (relates_to.rel_type === "m.replace" && relates_to.event_id !== undefined) {
                    // We have an edit.
                    try {
                        await room.onMatrixEdit(ev);
                    }
                    catch (e) {
                        log.error("Failed procesing matrix edit: ", e);
                        endTimer({ outcome: "fail" });
                        return;
                    }
                    endTimer({ outcome: "success" });
                    return;
                }
            }
            try {
                await room.onMatrixMessage(ev);
            }
            catch (e) {
                log.error("Failed procesing matrix message: ", e);
                endTimer({ outcome: "fail" });
                return;
            }
            endTimer({ outcome: "success" });
            return;
        }
    }
    async onMatrixAdminMessage(ev) {
        let cmd = ev.content.body;
        // Ignore "# comment" lines as chatter between humans sharing the console
        if (cmd.match(/^\s*#/)) {
            return;
        }
        log.info("Admin: " + cmd);
        const response = [];
        const respond = (message) => {
            if (!response) {
                log.info("Command response too late: " + message);
                return;
            }
            response.push(message);
        };
        try {
            // This will return true or false if the command matched.
            const matched = await this.adminCommands.parse(cmd, respond);
            if (!matched) {
                log.debug("Unrecognised command: " + cmd);
                respond("Unrecognised command: " + cmd);
            }
            else if (response.length === 0) {
                respond("Done");
            }
        }
        catch (ex) {
            log.debug(`Command '${cmd}' failed to complete:`, ex);
            respond("Command failed: " + ex);
        }
        const message = response.join("\n");
        await this.botIntent.sendEvent(ev.room_id, "m.room.message", {
            msgtype: "m.notice",
            body: message,
            format: "org.matrix.custom.html",
            formatted_body: `<pre>${message}</pre>`,
        });
    }
    async run(port) {
        log.info("Loading databases");
        await this.bridge.loadDatabases();
        log.info("Loading teams.db");
        this.teamDatastore = new Datastore({ filename: './teams.db', autoload: true });
        await new Promise((resolve, reject) => {
            this.teamDatastore.loadDatabase((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                ;
                resolve();
            });
        });
        // Legacy-style BridgedRoom instances
        (await this.roomStore.select({
            matrix_id: { $exists: false },
        })).forEach((entry) => {
            log.error("Ignoring LEGACY room entry in room-store.db", entry);
        });
        await this.slackHookHandler.startAndListen(this.config.slack_hook_port, this.config.tls);
        this.bridge.run(port, this.config);
        Provisioning.addAppServicePath(this.bridge, this);
        // TODO(paul): see above; we had to defer this until now
        this.stateStorage = new matrix_appservice_bridge_1.StateLookup({
            eventTypes: ["m.room.member", "m.room.power_levels"],
            client: this.bridge.getIntent().client,
        });
        const entries = await this.roomStore.select({
            matrix_id: { $exists: true },
        });
        entries.forEach((entry) => {
            // These might be links for legacy-style BridgedRooms, or new-style
            // rooms
            // Only way to tell is via the form of the id
            const result = entry.id.match(/^INTEG-(.*)$/);
            if (result) {
                var room = BridgedRoom_1.BridgedRoom.fromEntry(this, entry);
                this.addBridgedRoom(room);
                this.roomsByMatrixRoomId[entry.matrix_id] = room;
                this.stateStorage.trackRoom(entry.matrix_id);
            }
            else {
                log.error("Ignoring LEGACY room link entry", entry);
            }
        });
        if (this.metrics) {
            this.metrics.addAppServicePath(this.bridge);
            // Send process stats again just to make the counters update sooner after
            // startup
            this.metrics.refresh();
        }
        log.info("Bridge initialised.");
    }
    // This so-called "link" action is really a multi-function generic provisioning
    // interface. It will
    //  * Create a BridgedRoom instance, linked to the given Matrix room ID
    //  * Associate a webhook_uri to an existing instance
    async actionLink(opts) {
        const matrixRoomId = opts.matrix_room_id;
        let existingRoom = this.getRoomByMatrixRoomId(matrixRoomId);
        let room;
        let isNew = false;
        if (!existingRoom) {
            try {
                await this.botIntent.join(matrixRoomId);
            }
            catch (ex) {
                log.error("Couldn't join room, not bridging");
                throw Error("Could not join room");
            }
            const inboundId = this.genInboundId();
            room = new BridgedRoom_1.BridgedRoom(this, {
                inbound_id: inboundId,
                matrix_room_id: matrixRoomId,
            });
            isNew = true;
            this.roomsByMatrixRoomId[matrixRoomId] = room;
            this.stateStorage.trackRoom(matrixRoomId);
        }
        else {
            room = existingRoom;
        }
        if (opts.slack_webhook_uri) {
            room.SlackWebhookUri = opts.slack_webhook_uri;
        }
        if (opts.slack_channel_id) {
            room.SlackChannelId = opts.slack_channel_id;
        }
        if (opts.slack_user_token) {
            room.SlackUserToken = opts.slack_user_token;
        }
        let teamToken = opts.slack_bot_token;
        if (opts.team_id) {
            teamToken = (await this.getTeamFromStore(opts.team_id)).bot_token;
        }
        if (teamToken) {
            room.SlackBotToken = teamToken;
            this.incRemoteCallCounter("channels.info");
            const response = await rp({
                url: "https://slack.com/api/channels.info",
                qs: {
                    token: teamToken,
                    channel: opts.slack_channel_id,
                },
                json: true
            });
            if (!response.ok) {
                log.error(`channels.info for ${opts.slack_channel_id} errored:`, response);
                throw Error("Failed to get channel info");
            }
            room.SlackChannelName = response.channel.name;
            await Promise.all([
                room.refreshTeamInfo(),
                room.refreshUserInfo(),
                response,
            ]);
        }
        if (isNew) {
            this.addBridgedRoom(room);
        }
        if (room.isDirty) {
            this.putRoomToStore(room);
        }
        return room;
    }
    async actionUnlink(opts) {
        const room = this.getRoomByMatrixRoomId(opts.matrix_room_id);
        if (!room) {
            throw "Cannot unlink - unknown channel";
        }
        this.removeBridgedRoom(room);
        delete this.roomsByMatrixRoomId[opts.matrix_room_id];
        this.stateStorage.untrackRoom(opts.matrix_room_id);
        const id = room.toEntry().id;
        await this.drainAndLeaveMatrixRoom(opts.matrix_room_id);
        await this.roomStore.delete({ id });
    }
    async checkLinkPermission(matrixRoomId, userId) {
        // We decide to allow a user to link or unlink, if they have a powerlevel
        //   sufficient to affect the 'm.room.power_levels' state; i.e. the
        //   "operator" heuristic.
        const powerLevels = await this.getState(matrixRoomId, "m.room.power_levels");
        const user_level = (powerLevels.users && userId in powerLevels.users) ? powerLevels.users[userId] :
            powerLevels.users_default;
        const requires_level = (powerLevels.events && "m.room.power_levels" in powerLevels.events) ? powerLevels.events["m.room.power_levels"] :
            ("state_default" in powerLevels) ? powerLevels.powerLevels :
                50;
        return user_level >= requires_level;
    }
    async setUserAccessToken(userId, teamId, slackId, accessToken) {
        const store = this.userStore;
        let matrixUser = await store.getMatrixUser(userId);
        matrixUser = matrixUser ? matrixUser : new matrix_appservice_bridge_1.MatrixUser(userId);
        const accounts = matrixUser.get("accounts") || {};
        accounts[slackId] = {
            team_id: teamId,
            access_token: accessToken,
        };
        matrixUser.set("accounts", accounts);
        await store.setMatrixUser(matrixUser);
        log.info(`Set new access token for ${userId} (team: ${teamId})`);
    }
    updateTeamBotStore(teamId, teamName, userId, botToken) {
        this.teamDatastore.update({ team_id: teamId }, {
            team_id: teamId,
            team_name: teamName,
            bot_token: botToken,
            user_id: userId,
        }, { upsert: true });
        log.info(`Setting details for team ${teamId} ${teamName}`);
    }
    getTeamFromStore(teamId) {
        return new Promise((resolve, reject) => {
            this.teamDatastore.findOne({ team_id: teamId }, (err, doc) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(doc);
            });
        });
    }
    async matrixUserInSlackTeam(teamId, userId) {
        const matrixUser = await this.userStore.getMatrixUser(userId);
        if (matrixUser === null) {
            return false;
        }
        const accounts = Object.values(matrixUser.get("accounts"));
        return accounts.find((acct) => acct.team_id === teamId);
    }
}
exports.Main = Main;
Provisioning.commands.getbotid = new Provisioning.Command({
    params: [],
    func: function (main, req, res) {
        res.json({ bot_user_id: main.botUserId });
    }
});
Provisioning.commands.authurl = new Provisioning.Command({
    params: ["user_id"],
    func: function (main, req, res, user_id) {
        if (!main.oauth2) {
            res.status(400).json({
                error: "OAuth2 not configured on this bridge",
            });
            return;
        }
        const token = main.oauth2.getPreauthToken(user_id);
        const auth_uri = main.oauth2.makeAuthorizeURL(token, token);
        res.json({ auth_uri });
    }
});
Provisioning.commands.logout = new Provisioning.Command({
    params: ["user_id", "slack_id"],
    func: async function (main, req, res, user_id, slack_id) {
        if (!main.oauth2) {
            res.status(400).json({
                error: "OAuth2 not configured on this bridge",
            });
            return;
        }
        const store = main.userStore;
        let matrixUser = await store.getMatrixUser(user_id);
        matrixUser = matrixUser ? matrixUser : new matrix_appservice_bridge_1.MatrixUser(user_id);
        const accounts = matrixUser.get("accounts") || {};
        delete accounts[slack_id];
        matrixUser.set("accounts", accounts);
        store.setMatrixUser(matrixUser);
        log.info(`Removed account ${slack_id} from ${user_id}`);
    }
});
Provisioning.commands.channels = new Provisioning.Command({
    params: ["user_id", "team_id"],
    func: async function (main, req, res, user_id, team_id) {
        const store = main.userStore;
        log.debug(`${user_id} requested their teams`);
        main.incRemoteCallCounter("conversations.list");
        const matrixUser = await store.getMatrixUser(user_id);
        const isAllowed = matrixUser !== null &&
            Object.values(matrixUser.get("accounts")).find((acct) => acct.team_id === team_id);
        if (!isAllowed) {
            res.status(403).json({ error: "User is not part of this team!" });
            throw undefined;
        }
        const team = await main.getTeamFromStore(team_id);
        if (team === null) {
            throw new Error("No team token for this team_id");
        }
        const response = await rp({
            url: "https://slack.com/api/conversations.list",
            qs: {
                token: team.bot_token,
                exclude_archived: true,
                types: "public_channel",
                limit: 100,
            },
            json: true,
        });
        if (!response.ok) {
            log.error(`Failed trying to fetch channels for ${team_id}.`, response);
            res.status(500).json({ error: "Failed to fetch channels" });
            return;
        }
        res.json({
            channels: response.channels.map((chan) => ({
                id: chan.id,
                name: chan.name,
                topic: chan.topic,
                purpose: chan.purpose,
            }))
        });
    }
});
Provisioning.commands.teams = new Provisioning.Command({
    params: ["user_id"],
    func: async function (main, req, res, user_id) {
        log.debug(`${user_id} requested their teams`);
        const store = main.userStore;
        const matrixUser = await store.getMatrixUser(user_id);
        if (matrixUser === null) {
            res.status(404).json({ error: "User has no accounts setup" });
            return;
        }
        const accounts = matrixUser.get("accounts");
        const results = await Promise.all(Object.keys(accounts).map((slack_id) => {
            const account = accounts[slack_id];
            return main.getTeamFromStore(account.team_id).then((team) => ({ team, slack_id }));
        }));
        const teams = results.map((res) => ({
            id: res.team.team_id,
            name: res.team.team_name,
            slack_id: res.slack_id,
        }));
        res.json({ teams });
    }
});
Provisioning.commands.getlink = new Provisioning.Command({
    params: ["matrix_room_id", "user_id"],
    func: async function (main, req, res, matrix_room_id, user_id) {
        const room = main.getRoomByMatrixRoomId(matrix_room_id);
        if (!room) {
            res.status(404).json({ error: "Link not found" });
            return;
        }
        log.info("Need to enquire if " + user_id + " is allowed to get links for " + matrix_room_id);
        const allowed = await main.checkLinkPermission(matrix_room_id, user_id);
        if (!allowed) {
            throw {
                code: 403,
                text: user_id + " is not allowed to provision links in " + matrix_room_id
            };
        }
        // Convert the room 'status' into a scalar 'status'
        let status = room.getStatus();
        if (status.match(/^ready/)) {
            // OK
        }
        else if (status === "pending-params") {
            status = "partial";
        }
        else if (status === "pending-name") {
            status = "pending";
        }
        else {
            status = "unknown";
        }
        let authUri;
        if (main.oauth2 && !room.AccessToken) {
            // We don't have an auth token but we do have the ability
            // to ask for one
            authUri = main.oauth2.makeAuthorizeURL(room, room.InboundId);
        }
        res.json({
            status: status,
            slack_channel_id: room.SlackChannelId,
            slack_channel_name: room.SlackChannelName,
            slack_webhook_uri: room.SlackWebhookUri,
            team_id: room.SlackTeamId,
            isWebhook: !room.SlackBotId,
            // This is slightly a lie
            matrix_room_id: matrix_room_id,
            inbound_uri: main.getInboundUrlForRoom(room),
            auth_uri: authUri,
        });
    }
});
Provisioning.commands.link = new Provisioning.Command({
    params: ["matrix_room_id", "user_id"],
    func: async function (main, req, res, matrix_room_id, user_id) {
        log.info("Need to enquire if " + user_id + " is allowed to link " + matrix_room_id);
        // Ensure we are in the room.
        await main.botIntent.join(matrix_room_id);
        const params = req.body;
        const opts = {
            matrix_room_id: matrix_room_id,
            slack_webhook_uri: params.slack_webhook_uri,
            slack_channel_id: params.channel_id,
            team_id: params.team_id,
            user_id: params.user_id,
        };
        // Check if the user is in the team.
        if (opts.team_id && !(await main.matrixUserInSlackTeam(opts.team_id, opts.user_id))) {
            return Promise.reject({
                code: 403,
                text: user_id + " is not in this team.",
            });
        }
        if (!(await main.checkLinkPermission(matrix_room_id, user_id))) {
            return Promise.reject({
                code: 403,
                text: user_id + " is not allowed to provision links in " + matrix_room_id,
            });
        }
        const room = await main.actionLink(opts);
        // Convert the room 'status' into a scalar 'status'
        var status = room.getStatus();
        if (status === "ready") {
            // OK
        }
        else if (status === "pending-params") {
            status = "partial";
        }
        else if (status === "pending-name") {
            status = "pending";
        }
        else {
            status = "unknown";
        }
        log.info(`Result of link for ${matrix_room_id} -> ${status} ${opts.slack_channel_id}`);
        res.json({
            status: status,
            slack_channel_name: room.SlackChannelName,
            slack_webhook_uri: room.SlackWebhookUri,
            matrix_room_id: matrix_room_id,
            inbound_uri: main.getInboundUrlForRoom(room),
        });
    }
});
Provisioning.commands.unlink = new Provisioning.Command({
    params: ["matrix_room_id", "user_id"],
    func: async function (main, req, res, matrix_room_id, user_id) {
        log.info("Need to enquire if " + user_id + " is allowed to unlink " + matrix_room_id);
        const allowed = await main.checkLinkPermission(matrix_room_id, user_id);
        if (!allowed) {
            throw {
                code: 403,
                text: user_id + " is not allowed to provision links in " + matrix_room_id,
            };
        }
        await main.actionUnlink({ matrix_room_id });
        res.json({});
    }
});
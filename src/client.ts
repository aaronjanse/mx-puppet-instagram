import { Log } from "mx-puppet-bridge";
import {
	IgApiClient, DirectInboxFeed, IgLoginRequiredError, DirectThreadRepositoryBroadcastResponsePayload, DirectInboxFeedResponse,
} from "instagram-private-api";
import { EventEmitter } from "events";
import * as Jimp from "jimp";
import { Cookie } from "tough-cookie";

function logEvent(name: string) {
	return (data: any) => console.log(name, data);
}


import { IgApiClientRealtime, GraphQLSubscriptions, SkywalkerSubscriptions, withRealtime, MessageSyncMessageWrapper } from 'instagram_mqtt';

const log = new Log("InstagramPuppet:client");

const SEND_DELAY = 100;

export class Client extends EventEmitter {
	// tslint:disable:no-magic-numbers
	private backoffIntervals = [
		500, 500, 500, 500, 500, 500, 500, 500, 500, 500, // 5 seconds
		1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, // 8 seconds
		2000, 2000, 2000, 2000, 2000, 2000, // 12 seconds
		3000, 3000, 3000, 3000, 3000, // 15 seconds
		4000, 4000, 4000, 4000, 4000, // 20 seconds
		5000, 5000, 5000, 5000, 5000, // 25 seconds
		7500, 7500, 7500, 7500, 7500,
		10000,
	];
	// tslint:enable:no-magic-numbers
	private currBackoff: number = 0;
	private ig: IgApiClientRealtime;
	private threadMap: any = {};
	// private inboxFeed: DirectInboxFeed;
	private timeout: NodeJS.Timeout | null;
	private disconnecting: boolean;
	private lastThreadMessages: { [threadId: string]: number };
	private users: { [userId: string]: any };
	private sentEvents: string[];
	constructor(
		private sessionid: string,
		private username?: string,
		private password?: string,
	) {
		super();
		this.currBackoff = 0;
		this.ig = withRealtime(new IgApiClient());
		this.timeout = null;
		this.disconnecting = false;
		this.lastThreadMessages = {};
		this.users = {};
		this.sentEvents = [];
	}

	public async connect() {

		console.log("######### sessionid:", this.sessionid)
		console.log("######### username:", this.username)
		if (this.username) {
		}
		if (this.sessionid) {
			console.log("## USING SESSION ID")
			const cookies = {
				storeType: "MemoryCookieStore",
				rejectPublicSuffixes: true,
				cookies: [
					new Cookie({
						key: "sessionid",
						value: this.sessionid,
						domain: "instagram.com",
						path: "/",
						secure: true,
						httpOnly: true,
						hostOnly: false,
						maxAge: 31536000,
						creation: new Date(),
					}),
				],
			};
			console.log("!! IG STATE BEFORE:", this.ig.state)
			await this.ig.state.deserializeCookieJar(JSON.stringify(cookies));
			console.log("!! IG STATE AFTER:", this.ig.state)
		} else if (this.username && this.password) {
			console.log("######### LOGGING IN WITH USERNAME & PASSWORD")
			this.ig.state.generateDevice(this.username);
			await this.ig.simulate.preLoginFlow();
			await this.ig.account.login(this.username, this.password);
		} else {
			throw new Error("no login method provided");
		}
		console.log("IG STATE:", this.ig.state)
		console.log("PHONE ID:", this.ig.state.phoneId);

		const auth = await this.ig.account.currentUser();
		this.ig.state.generateDevice(auth.username);

		log.verbose(auth);
		const authUser = {
			userId: auth.pk.toString(),
			name: auth.full_name,
			avatar: auth.profile_pic_url,
			avatarId: auth.profile_pic_id,
		};
		this.users[authUser.userId] = authUser;
		this.emit("auth", authUser, auth);
		// this.inboxFeed = this.ig.feed.directInbox();
		// do in background
		// tslint:disable-next-line:no-floating-promises
		// this.singleUpdate();

		const subToLiveComments = (broadcastId: string) =>
			// you can add other GraphQL subs using .subscribe
			this.ig.realtime.graphQlSubscribe(GraphQLSubscriptions.getLiveRealtimeCommentsSubscription(broadcastId));

		this.ig.realtime.on('receive', (topic, messages) => {
			console.log('receive', topic, messages);
		});
		this.ig.realtime.on('direct', x => logEvent('direct'));
		// this is called with a wrapper use {message} to only get the message from the wrapper
		this.ig.realtime.on('message', async (msgWrapper: MessageSyncMessageWrapper) => {
			console.log("Got message :-)", msgWrapper)
			let msg = msgWrapper.message;
			if (msg.op != 'add') {
				console.log("Wrong msg op type; dropping msg.")
				return
			}
			// const thread = this.ig.entity.directThread(msg.thread_id);
			// this.ig.feed.directThread(msg)
			// this.ig.feed.directThread({thread_id: msg.thread_id}).request().then(thread => null)

			// console.log("Thread is...:", thread)

			// for (const user of thread.users) {
			// 	const newUser = {
			// 		userId: user.pk.toString(),
			// 		name: user.full_name,
			// 		avatar: user.profile_pic_url,
			// 		avatarId: user.profile_pic_id,
			// 	};

			// }

			let threadData = this.threadMap[msg.thread_id];
			if (!threadData) {
				this.updateThreads()
				threadData = this.threadMap[msg.thread_id];
			}
			console.log("GOT THREAD DATA", threadData)
			let event = {
				eventId: msg.item_id,
				userId: msg.user_id.toString(),
				threadId: msg.thread_id,
				isPrivate: threadData.isPrivate,
				threadTitle: threadData.thread_title,
			} as any;

			const oldUser = this.users[event.userId];
			if (!oldUser) {
				const userInfo = await this.ig.user.info(event.userId);
				this.users[event.userId] = {
					userId: event.userId,
					name: userInfo.full_name,
					avatar: userInfo.profile_pic_url,
					avatarId: userInfo.profile_pic_id,
				};
			}

			switch (msg.item_type) {
				case "text":
					event.text = msg.text;
					this.emit("message", event);
					break;
				// case "reel_share":
				// 	event.text = item.reel_share.text;
				// 	this.emit("reel_share", event, item.reel_share);
				// 	break;
				case "media_share":
					this.emit("media_share", event, msg.media_share);
					break;
				case "media":
					if (msg.media) {
						event.url = msg.media.image_versions2?.candidates[0].url;
						this.emit("file", event);
					} else {
						console.log("got media message without media!", msg)
					}
					break;
				case "voice_media":
					event.url = msg.voice_media?.media.audio.audio_src;
					this.emit("file", event);
					break;
				case "like":
					console.log("got msg", msg, "with reacts", msg.reactions)
					break;
				case "action_log":
					const action_log = (msg as any).action_log;
					if (action_log) {
						event.text = action_log.description
						this.emit("message", event);
					}
				case "animated_media":
					event.url = msg.animated_media?.images.fixed_height?.url;
					this.emit("file", event);
					break;
				default:
					console.log("Unknown item type", msg);
			}
		});
		// whenever something gets sent to /ig_realtime_sub and has no event, this is called
		this.ig.realtime.on('realtimeSub', logEvent('realtimeSub'));
		// whenever the client has a fatal error
		this.ig.realtime.on('error', console.error);
		this.ig.realtime.on('close', () => console.error('RealtimeClient closed'));

		const inboxData = await this.updateThreads();
		// connect
		// this will resolve once all initial subscriptions have been sent
		await this.ig.realtime.connect({
			// optional
			graphQlSubs: [
				// these are some subscriptions
				GraphQLSubscriptions.getAppPresenceSubscription(),
				GraphQLSubscriptions.getZeroProvisionSubscription(this.ig.state.phoneId),
				GraphQLSubscriptions.getDirectStatusSubscription(),
				GraphQLSubscriptions.getDirectTypingSubscription(this.ig.state.cookieUserId),
				GraphQLSubscriptions.getAsyncAdSubscription(this.ig.state.cookieUserId),
			],
			// optional
			skywalkerSubs: [
				SkywalkerSubscriptions.directSub(this.ig.state.cookieUserId),
				SkywalkerSubscriptions.liveSub(this.ig.state.cookieUserId)
			],
			// optional
			// this enables you to get direct messages
			irisData: inboxData,
			// optional
			// in here you can change connect options
			// available are all properties defined in MQTToTConnectionClientInfo
			connectOverrides: {
			},
		});

		// simulate turning the device off after 2s and turning it back on after another 2s
		setTimeout(() => {
			console.log('Device off');
			// from now on, you won't receive any realtime-data as you "aren't in the app"
			// the keepAliveTimeout is somehow a 'constant' by instagram
			this.ig.realtime.direct.sendForegroundState({ inForegroundApp: false, inForegroundDevice: false, keepAliveTimeout: 900 });
		}, 2000);
		setTimeout(() => {
			console.log('In App');
			this.ig.realtime.direct.sendForegroundState({ inForegroundApp: true, inForegroundDevice: true, keepAliveTimeout: 60 });
		}, 4000);
	}

	public async updateThreads(): Promise<DirectInboxFeedResponse> {
		let inboxData = await this.ig.feed.directInbox().request();
		// console.log("inboxData::", inboxData)
		
		for (var thread of inboxData.inbox.threads) {
			console.log("thread::", thread)
			this.threadMap[thread.thread_id] = {
				thread_title: thread.thread_title,
				isPrivate: thread.users.length < 2,
			}
			console.log("threadMap +=", {
				thread_title: thread.thread_title,
				isPrivate: thread.users.length < 2,
			})
		}

		return inboxData
	}

	public async disconnect() {
		this.disconnecting = true;
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
		}
	}

	public getUser(id: string): any | null {
		log.verbose(id);
		log.verbose(this.users);
		if (!this.users[id]) {
			return null;
		}
		return this.users[id];
	}

	public async sendMessage(threadId: string, text: string): Promise<string | null> {
		const thread = this.ig.entity.directThread(threadId);
		const ret = await thread.broadcastText(text);
		if (!ret) {
			return null;
		}
		const id = (ret as DirectThreadRepositoryBroadcastResponsePayload).item_id;
		if (id) {
			this.sentEvents.push(id);
			return id;
		}
		return null;
	}

	public async sendPhoto(threadId: string, file: Buffer): Promise<string | null> {
		const image = await Jimp.read(file);
		const WHITE = 0xFFFFFFFF;
		image.rgba(false).background(WHITE);
		const jpg = await image.getBufferAsync(Jimp.MIME_JPEG);
		const thread = this.ig.entity.directThread(threadId);
		const ret = await thread.broadcastPhoto({
			file: jpg,
		});
		if (!ret) {
			return null;
		}
		const id = (ret as DirectThreadRepositoryBroadcastResponsePayload).item_id;
		if (id) {
			this.sentEvents.push(id);
			return id;
		}
		return null;
	}

	public async sendLink(threadId: string, name: string, url: string): Promise<string | null> {
		const thread = this.ig.entity.directThread(threadId);
		const ret = await thread.broadcastLink(name, [url]);
		if (!ret) {
			return null;
		}
		const id = (ret as DirectThreadRepositoryBroadcastResponsePayload).item_id;
		if (id) {
			this.sentEvents.push(id);
			return id;
		}
		return null;
	}

	private igTsToNormal(ts: string): number {
		// instagram TS's are in microseconds
		const MICRO_TO_MILLI = 3;
		return parseInt(ts.substring(0, ts.length - MICRO_TO_MILLI), 10);
	}

	private async singleUpdate() {
		// let processedMessage = false;
		// try {
		// 	const threads = await this.inboxFeed.items();
		// 	for (const thread of threads) {
		// 		// first we update users accordingly
		// 		for (const user of thread.users) {
		// 			const newUser = {
		// 				userId: user.pk.toString(),
		// 				name: user.full_name,
		// 				avatar: user.profile_pic_url,
		// 				avatarId: user.profile_pic_id,
		// 			};
		// 			const oldUser = this.users[newUser.userId];
		// 			if (oldUser) {
		// 				// okay, the problem is that instagram changes the avatar url
		// 				// on every single message sent, so we have nothing
		// 				// to keep track of the actual avatar without uploading tons of duplicates
		// 				// so instead, we need to check for a change in the avatarId
		// 				if (newUser.name !== oldUser.name || newUser.avatarId !== oldUser.avatarId) {
		// 					this.emit("userupdate", newUser);
		// 					this.users[newUser.userId] = newUser;
		// 				}
		// 			} else {
		// 				this.users[newUser.userId] = newUser;
		// 			}
		// 		}

		// 		const threadId = thread.thread_id;
		// 		const oldTs = this.lastThreadMessages[threadId];
		// 		if (!oldTs) {
		// 			this.lastThreadMessages[threadId] = thread.items[0] ? this.igTsToNormal(thread.items[0].timestamp) : 0;
		// 			continue;
		// 		}
		// 		thread.items.reverse(); // we want to process the oldest one first
		// 		let sendDelay = 0;
		// 		for (const item of thread.items as any[]) {
		// 			const ts = this.igTsToNormal(item.timestamp);
		// 			if (oldTs >= ts) {
		// 				continue;
		// 			}
		// 			if (this.sentEvents.includes(item.item_id)) {
		// 				// duplicate, ignore
		// 				// remove the entry from the array because, well it is unneeded now
		// 				const ix = this.sentEvents.indexOf(item.item_id);
		// 				if (ix !== -1) {
		// 					this.sentEvents.splice(ix, 1);
		// 				}
		// 			} else {
		// 				// we have a new message!!!!
		// 				processedMessage = true;
		// const event = {
		// 	eventId: item.item_id,
		// 	userId: item.user_id.toString(),
		// 	threadId,
		// 	isPrivate: thread.thread_type === "private",
		// 	threadTitle: thread.thread_title,
		// } as any;
		// 				setTimeout(() => {
		// switch (item.item_type) {
		// 	case "text":
		// 		event.text = item.text;
		// 		this.emit("message", event);
		// 		break;
		// 	case "reel_share":
		// 		event.text = item.reel_share.text;
		// 		this.emit("reel_share", event, item.reel_share);
		// 		break;
		// 	case "media_share":
		// 		this.emit("media_share", event, item.media_share);
		// 		break;
		// 	case "media":
		// 		event.url = item.media.image_versions2.candidates[0].url;
		// 		this.emit("file", event);
		// 		break;
		// 	case "voice_media":
		// 		event.url = item.voice_media.media.audio.audio_src;
		// 		this.emit("file", event);
		// 		break;
		// 	case "like":
		// 		event.text = item.like;
		// 		this.emit("message", event);
		// 		break;
		// 	case "animated_media":
		// 		event.url = item.animated_media.images.fixed_height.url;
		// 		this.emit("file", event);
		// 		break;
		// 	default:
		// 		log.silly("Unknown item type", item);
		// }
		// 				}, sendDelay);
		// 				sendDelay += SEND_DELAY;
		// 			}
		// 			this.lastThreadMessages[threadId] = ts;
		// 		}
		// 	}
		// } catch (err) {
		// 	if (err instanceof IgLoginRequiredError) {
		// 		// we aren't logged in anymore, somehow. Please stand by while we panic
		// 		this.emit("logout");
		// 		await this.disconnect();
		// 		return;
		// 	}
		// 	log.error("Error updating from instagram:", err);
		// }

		// if (!this.disconnecting) {
		// 	// backoff logic
		// 	if (!processedMessage) {
		// 		if (this.currBackoff < this.backoffIntervals.length - 1) {
		// 			this.currBackoff++;
		// 		}
		// 	} else {
		// 		this.currBackoff = 0;
		// 	}
		// 	// this.timeout = setTimeout(this.singleUpdate.bind(this), this.backoffIntervals[this.currBackoff]);
		// }
	}
}

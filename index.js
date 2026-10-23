import { ChannelType, Client, Events, GatewayIntentBits, Status } from 'discord.js';
import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from '@discordjs/voice';

const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  channelId: process.env.VOICE_CHANNEL_ID,
  selfDeaf: process.env.SELF_DEAF !== 'false',
  selfMute: process.env.SELF_MUTE === 'true',
};

const limits = {
  baseDelayMs: 3_000,
  maxDelayMs: 300_000,
  windowMs: 600_000,
  maxAttempts: 6,
  cooldownMs: 600_000,
  stableMs: 60_000,
  healthCheckMs: 30_000,
  connectTimeoutMs: 30_000,
  recoverTimeoutMs: 5_000,
};

const log = (level, message, error) => {
  const detail = error ? ` | ${error instanceof Error ? error.message : String(error)}` : '';
  const line = `[${new Date().toISOString()}] [${level}] ${message}${detail}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const safeDestroy = (connection) => {
  try {
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
  } catch (error) {
    log('WARN', 'Failed to destroy voice connection', error);
  }
};

process.on('unhandledRejection', (reason) => log('ERROR', 'Unhandled rejection', reason));
process.on('uncaughtException', (error) => log('ERROR', 'Uncaught exception', error));

const missing = Object.entries({
  DISCORD_TOKEN: config.token,
  GUILD_ID: config.guildId,
  VOICE_CHANNEL_ID: config.channelId,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  log('ERROR', `Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

class RejoinLimiter {
  constructor(options) {
    this.options = options;
    this.attempts = [];
    this.failures = 0;
    this.blockedUntil = 0;
  }

  record() {
    this.attempts.push(Date.now());
    this.failures += 1;
  }

  reset() {
    this.failures = 0;
  }

  nextDelay() {
    const { windowMs, maxAttempts, cooldownMs, baseDelayMs, maxDelayMs } = this.options;
    const now = Date.now();

    if (now < this.blockedUntil) return this.blockedUntil - now;

    this.attempts = this.attempts.filter((time) => now - time < windowMs);

    if (this.attempts.length >= maxAttempts) {
      this.blockedUntil = now + cooldownMs;
      this.attempts = [];
      log('WARN', `Rejoin limit reached, cooling down for ${Math.round(cooldownMs / 1000)}s`);
      return cooldownMs;
    }

    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** this.failures);
    return Math.round(delay + Math.random() * delay * 0.25);
  }
}

class VoiceKeeper {
  constructor(client, settings, options) {
    this.client = client;
    this.settings = settings;
    this.options = options;
    this.limiter = new RejoinLimiter(options);
    this.connection = null;
    this.timer = null;
    this.stableTimer = null;
    this.healthTimer = null;
    this.connecting = false;
    this.stopped = false;
  }

  start() {
    this.client.on(Events.VoiceStateUpdate, (_oldState, newState) => this.onVoiceStateUpdate(newState));
    this.client.on(Events.ShardResume, () => this.verify('shard resumed'));
    this.client.on(Events.ShardReady, () => this.verify('shard ready'));
    this.healthTimer = setInterval(() => this.verify('health check'), this.options.healthCheckMs);
    this.run();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
    this.release();
  }

  run() {
    this.connect().catch((error) => log('ERROR', 'Unexpected connect failure', error));
  }

  isHealthy() {
    const guild = this.client.guilds.cache.get(this.settings.guildId);
    const currentChannelId = guild?.voiceStates.cache.get(this.client.user.id)?.channelId;
    return (
      this.connection?.state.status === VoiceConnectionStatus.Ready &&
      currentChannelId === this.settings.channelId
    );
  }

  verify(reason) {
    try {
      if (this.stopped || this.connecting || this.timer) return;
      if (this.client.ws.status !== Status.Ready) return;
      if (this.isHealthy()) return;
      this.schedule(reason);
    } catch (error) {
      log('ERROR', 'Verification failed', error);
    }
  }

  onVoiceStateUpdate(state) {
    try {
      if (this.stopped) return;
      if (state.id !== this.client.user.id || state.guild.id !== this.settings.guildId) return;
      if (state.channelId === this.settings.channelId) return;
      this.schedule(state.channelId ? 'moved to another channel' : 'removed from channel');
    } catch (error) {
      log('ERROR', 'Voice state handler failed', error);
    }
  }

  schedule(reason, delay) {
    if (this.stopped || this.timer) return;
    const wait = delay ?? this.limiter.nextDelay();
    log('WARN', `Rejoin scheduled in ${Math.round(wait / 1000)}s (${reason})`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, wait);
  }

  async resolveChannel() {
    const { guildId, channelId } = this.settings;
    const guild = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId));
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));

    if (!channel?.isVoiceBased()) throw new Error('Target channel is not a voice channel');
    if (!channel.joinable) throw new Error('Channel is not joinable (permissions or full)');

    return channel;
  }

  async prepareStage(channel) {
    if (channel.type !== ChannelType.GuildStageVoice) return;
    try {
      await channel.guild.members.me?.voice.setSuppressed(false);
    } catch (error) {
      log('WARN', 'Failed to become a speaker in stage channel', error);
    }
  }

  release() {
    const previous = this.connection;
    this.connection = null;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
    safeDestroy(previous);
    safeDestroy(getVoiceConnection(this.settings.guildId));
  }

  markStable() {
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.limiter.reset();
    }, this.options.stableMs);
  }

  attach(connection) {
    this.connection = connection;

    connection.on(VoiceConnectionStatus.Ready, () => this.markStable());

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.recover(connection).catch((error) => log('ERROR', 'Recovery failed', error));
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection !== connection) return;
      this.connection = null;
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
      this.schedule('connection destroyed');
    });

    connection.on('error', (error) => log('ERROR', 'Voice connection error', error));
  }

  async recover(connection) {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, this.options.recoverTimeoutMs),
        entersState(connection, VoiceConnectionStatus.Connecting, this.options.recoverTimeoutMs),
      ]);
    } catch {
      if (this.connection !== connection) return;
      log('WARN', 'Voice connection lost');
      this.release();
      this.schedule('voice connection lost');
    }
  }

  async connect() {
    if (this.stopped || this.connecting) return;

    if (this.client.ws.status !== Status.Ready) {
      this.schedule('gateway not ready', 5_000);
      return;
    }

    if (this.isHealthy()) return;

    this.connecting = true;
    this.limiter.record();

    try {
      const channel = await this.resolveChannel();
      this.release();

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: this.settings.selfDeaf,
        selfMute: this.settings.selfMute,
      });

      this.attach(connection);
      await entersState(connection, VoiceConnectionStatus.Ready, this.options.connectTimeoutMs);
      await this.prepareStage(channel);
      log('INFO', `Connected to voice channel "${channel.name}"`);
    } catch (error) {
      log('ERROR', 'Failed to join voice channel', error);
      this.release();
      this.schedule('join failed');
    } finally {
      this.connecting = false;
    }
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const keeper = new VoiceKeeper(client, config, limits);
let shuttingDown = false;

client.on(Events.Error, (error) => log('ERROR', 'Client error', error));
client.on(Events.Warn, (message) => log('WARN', message));
client.on(Events.ShardError, (error, shardId) => log('ERROR', `Shard ${shardId} error`, error));
client.on(Events.ShardDisconnect, (event, shardId) => log('WARN', `Shard ${shardId} disconnected (code ${event?.code})`));
client.on(Events.ShardReconnecting, (shardId) => log('WARN', `Shard ${shardId} reconnecting`));

client.once(Events.ClientReady, (readyClient) => {
  try {
    log('INFO', `Logged in as ${readyClient.user.tag}`);
    keeper.start();
  } catch (error) {
    log('ERROR', 'Failed to start voice keeper', error);
  }
});

const login = async () => {
  for (let attempt = 0; !shuttingDown; attempt += 1) {
    try {
      await client.login(config.token);
      return;
    } catch (error) {
      if (error?.status === 401 || error?.code === 'TokenInvalid' || error?.code === 'DisallowedIntents') {
        log('ERROR', 'Fatal login error', error);
        process.exit(1);
      }
      const delay = Math.min(60_000, 2_000 * 2 ** attempt);
      log('ERROR', `Login failed, retrying in ${Math.round(delay / 1000)}s`, error);
      await sleep(delay);
    }
  }
};

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `${signal} received, shutting down`);
  try {
    keeper.stop();
    await client.destroy();
  } catch (error) {
    log('ERROR', 'Shutdown error', error);
  } finally {
    process.exit(0);
  }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

login().catch((error) => {
  log('ERROR', 'Fatal startup error', error);
  process.exit(1);
});

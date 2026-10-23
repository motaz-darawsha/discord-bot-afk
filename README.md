<div align="center">

# Discord Voice Bot

**A resilient Discord bot that stays in a voice channel 24/7 and rejoins automatically, with rate-limited backoff so Discord never sees spam.**

![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-latest-5865F2?logo=discord&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

English | [العربية](README.ar.md)

</div>

---

## Features

- Joins a configured voice (or stage) channel and stays there around the clock
- Rejoins automatically when kicked, disconnected, or moved to another channel
- Smart rejoin limiter: exponential backoff with jitter, a sliding-window attempt cap, and a cooldown that protects the bot from Discord rate limits even if someone keeps kicking it
- Self-healing: periodic health check plus gateway resume/ready hooks catch silent drops
- Crash-proof: every handler is guarded, process-level `unhandledRejection` / `uncaughtException` are logged instead of killing the bot
- Login retry with backoff, and a clean exit on fatal errors such as an invalid token
- Graceful shutdown on `SIGINT` / `SIGTERM`
- Single file, easy to read and extend
- Docker and GitHub Actions ready

## Requirements

- Node.js 22.12 or newer
- A Discord bot token

## Quick start

### 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. In the **Bot** tab, create the bot and copy its token.
3. No privileged intents are needed.
4. Invite the bot to your server (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=1049600
```

The permissions value `1049600` grants **View Channel** and **Connect**.

### 2. Get the IDs

Enable **Developer Mode** in Discord (Settings → Advanced), then right-click your server and the voice channel and choose **Copy ID**.

### 3. Install and run

```bash
git clone https://github.com/motaz-darawsha/discord-bot-afk.git
cd discord-bot-afk
npm install
cp .env.example .env
```

Fill in `.env`, then start the bot:

```bash
npm start
```

## Configuration

| Variable           | Required | Default | Description                              |
| ------------------ | -------- | ------- | ---------------------------------------- |
| `DISCORD_TOKEN`    | Yes      | none    | Your bot token                           |
| `GUILD_ID`         | Yes      | none    | The server (guild) ID                    |
| `VOICE_CHANNEL_ID` | Yes      | none    | The voice or stage channel to stay in    |
| `SELF_DEAF`        | No       | `true`  | Join deafened (set `false` to disable)   |
| `SELF_MUTE`        | No       | `false` | Join muted (set `true` to enable)        |

Never commit your `.env` file. It is already listed in `.gitignore`.

## Rejoin behavior

| Scenario                                  | What the bot does                                           |
| ----------------------------------------- | ----------------------------------------------------------- |
| Kicked or disconnected from the channel   | Waits for the backoff delay, then rejoins                   |
| Moved to another channel                  | Returns to the configured channel                           |
| Voice connection drops                    | Tries to recover for 5 seconds, then recreates the connection |
| Gateway disconnects and resumes           | Health check and shard hooks verify and rejoin if needed    |
| Channel missing, full, or no permissions  | Logs the reason and keeps retrying with growing delays      |
| Repeated kicks or spam                    | Backoff grows, the attempt cap triggers a long cooldown     |
| Unexpected error anywhere                 | Logged, the bot keeps running                               |

### Rate limit tuning

The defaults live in the `limits` object at the top of `index.js`:

| Option             | Default  | Meaning                                                     |
| ------------------ | -------- | ----------------------------------------------------------- |
| `baseDelayMs`      | 3,000    | First rejoin delay, doubled after every attempt             |
| `maxDelayMs`       | 300,000  | Upper bound for a single delay                              |
| `maxAttempts`      | 6        | Rejoin attempts allowed inside the window                   |
| `windowMs`         | 600,000  | Sliding window used to count attempts                       |
| `cooldownMs`       | 600,000  | Pause once `maxAttempts` is reached                         |
| `stableMs`         | 60,000   | Time connected before the backoff counter resets            |
| `healthCheckMs`    | 30,000   | Interval of the self-healing check                          |
| `connectTimeoutMs` | 30,000   | How long to wait for the voice connection to become ready   |

## Deployment

### Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

### PM2

```bash
npm install -g pm2
pm2 start index.js --name discord-voice-bot --node-args="--env-file=.env"
pm2 save
```

## Project structure

```
.
├── .github/workflows/ci.yml   Syntax check on every push and pull request
├── .env.example               Environment variables template
├── Dockerfile
├── docker-compose.yml
├── index.js                   The bot
├── package.json
├── LICENSE
├── README.md
└── README.ar.md
```

## Troubleshooting

- **Missing environment variables**: the bot prints which ones and exits. Check your `.env`.
- **Channel is not joinable**: give the bot **View Channel** and **Connect** on that channel, and make sure the channel is not full.
- **Fatal login error**: the token is invalid. Reset it in the Developer Portal and update `.env`.
- **Stage channel**: the bot tries to become a speaker automatically. If it stays suppressed, grant it **Mute Members** or invite it to speak manually.

## Credits

Created by **Motaz Darawsha** using **Claude Code**.

## License

Released under the [MIT License](LICENSE).

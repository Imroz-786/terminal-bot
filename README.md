# IRIS 4.0 🤖
> A self-modifying WhatsApp bot that gives you full terminal control of your Linux laptop — built with Node.js, Groq LLM, and whatsapp-web.js.

## Features
- 💬 Natural language commands via WhatsApp
- 🖥️ Full terminal access from your phone
- 🧠 Groq LLM powered intent detection
- 🔒 Password protected sessions
- 🚫 Command blacklist for safety
- 🔧 Self-modifying — adds its own features via AI
- 📊 Live system stats (CPU, RAM, Disk, Temp)
- 🚀 Auto-starts on boot via PM2

## Requirements
- Ubuntu 22.04 LTS
- Node.js v18+
- PM2
- Groq API key (free at console.groq.com)
- WhatsApp account

## Setup

### 1. Clone the repo
\`\`\`bash
git clone https://github.com/yourusername/iris4-bot.git
cd iris4-bot
\`\`\`

### 2. Install dependencies
\`\`\`bash
npm install
\`\`\`

### 3. Configure environment
\`\`\`bash
cp config.example.json .env
nano .env
\`\`\`
Fill in your Groq API key, WhatsApp group ID, and password.

### 4. Run the bot
\`\`\`bash
node index.js
\`\`\`
Scan the QR code with WhatsApp when prompted.

### 5. Auto-start on boot (optional)
\`\`\`bash
pm2 start index.js --name iris4
pm2 save
pm2 startup
\`\`\`

## Commands
| Command | Description |
|---|---|
| `!login <password>` | Authenticate |
| `!run <command>` | Run terminal command |
| `! <natural language>` | Talk naturally |
| `!ai <question>` | Ask AI directly |
| `!blacklist list` | Show blocked commands |
| `!help` | Show all commands |

## How to get your WhatsApp Group ID
1. Start the bot
2. Send any message in your group
3. Check terminal logs for the group ID ending in `@g.us`

## Security
- Never share your `.env` file
- Change default password immediately
- Review blacklist before deploying

## Built by
Imroz — Engineering Student, Ubuntu 22.04

## License
MIT
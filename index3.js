require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const os = require('os');

// this is backup file
// ═══════════════════════════════════════════════════════════════════════════
// 1. CONFIGURATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG_FILE = './bot-config.json';

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaults = {
      password: process.env.BOT_PASSWORD || 'changeme123',
      authorized_ids: [process.env.AUTHORIZED_ID],
      group_id: process.env.GROUP_ID,
      blacklist: [
        'rm -rf /',
        'mkfs',
        'dd if=',
        ':(){:|:&};:',
        'chmod -R 777 /',
        'wget.*| bash',
        'curl.*| bash',
        'halt',
        'poweroff',
      ],
      timeout_ms: 15000,
      max_output_chars: 3000,
      ai_enabled: true,
      sessions: [], // Properly initialized as an array to prevent iteration errors
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Initialize Active Config and Authenticated State
const cfgInit = loadConfig();
const authenticated = new Set(cfgInit.sessions || []);

// ═══════════════════════════════════════════════════════════════════════════
// 2. GROQ LLM INTEGRATION (IRIS 4.0)
// ═══════════════════════════════════════════════════════════════════════════
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function detectIntent(message) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `You are an intent classifier for a Linux laptop assistant.
Classify the user message into one of these intents and return ONLY valid JSON, nothing else:

Intents:
- run_command: user wants to execute something on the laptop (open app, list files, check something)
- change_dir: user wants to navigate to a folder
- ai_question: user has a general question, needs information or motivation
- system_info: user wants CPU, RAM, disk, uptime, temperature info
- blacklist_add: user wants to block a command
- blacklist_remove: user wants to unblock a command  
- blacklist_list: user wants to see blocked commands
- change_password: user wants to change the bot password
- show_config: user wants to see bot settings
- explain_command: user wants to understand what a command does
- unknown: cannot determine intent

Return this exact JSON format:
{
  "intent": "run_command",
  "command": "firefox",
  "explanation": "Opening Firefox browser",
  "safe": true
}

For non-command intents, set command to null.
For safe: false if the command looks dangerous.`
      },
      { role: 'user', content: message }
    ],
    max_tokens: 200,
    temperature: 0.1
  });

  const raw = res.choices[0].message.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No valid JSON extracted from intent classifier.');
  return JSON.parse(jsonMatch[0]);
}

async function askGroq(systemPrompt, userMessage, history = []) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,                          // 👈 inject past turns
      { role: 'user', content: userMessage },
    ],
    max_tokens: 1024,
  });
  return res.choices[0].message.content.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. HARDWARE & COMMAND SECURITY MIDDLEWARES
// ═══════════════════════════════════════════════════════════════════════════
const workingDirs = {};

function getCwd(senderId) {
  return workingDirs[senderId] || os.homedir();
}

// ─── Conversation history per sender ─────────────────────────────────────────
const conversationHistory = {};
const MAX_HISTORY = 20; // keep last 20 messages (10 turns)

function getHistory(senderId) {
  return conversationHistory[senderId] || [];
}

function addToHistory(senderId, role, content) {
  if (!conversationHistory[senderId]) conversationHistory[senderId] = [];
  conversationHistory[senderId].push({ role, content });
  // Trim to last MAX_HISTORY messages
  if (conversationHistory[senderId].length > MAX_HISTORY) {
    conversationHistory[senderId] = conversationHistory[senderId].slice(-MAX_HISTORY);
  }
}

function isBlacklisted(cmd, cfg) {
  return cfg.blacklist.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(cmd);
    } catch {
      return cmd.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

function runCommand(cmd, cfg) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: cfg.timeout_ms, shell: '/bin/bash' }, (err, stdout, stderr) => {
      let out = (stdout || '') + (stderr || '');
      out = out.trim();
      if (!out) out = err ? `[Error: ${err.message}]` : '[No output]';
      if (out.length > cfg.max_output_chars) {
        out = out.slice(0, cfg.max_output_chars) + `\n… [truncated, ${out.length} chars total]`;
      }
      resolve(out);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. WHATSAPP BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'terminal-bot' }),
  puppeteer: { 
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
    ],
    protocolTimeout: 120000,
  }
});
client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code in WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ Bot is running smoothly!');
  const cfg = loadConfig();
  
  console.log('⏳ Waiting 5 seconds before sending...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('📤 Attempting to send to:', cfg.group_id);
  
  
  // --- Bot Alive Notification ---
  try {
    const aliveMessage = "🚀 *IRIS 4.0 is Online*\nSystem ready for commands. Type `!help` to start.";
    
    // This sends the message to your specific group ID from the config
    await client.sendMessage(cfg.group_id, aliveMessage);
    console.log(`📢 Startup message sent to group: ${cfg.group_id}`);
  } catch (err) {
    console.error("❌ Failed to send startup message:", err);
  }
  // ------------------------------

  console.log(`🔒 Active Password: ${cfg.password}`);
});

client.on('auth_failure', () => {
  console.error('❌ Authentication failed — clear out your .wwebjs_auth/ directory and reboot.');
});

// Help Text UI Blueprint
const HELP_MENU = `*🤖🛠️ USER's Control Panel*

*Auth System*
• \`!login <password>\` — start session
• \`!logout\` — terminate session

*System Interface*
• \`!run <cmd>\` — execute terminal line
• \`!cd <dir>\` — map new directory path
• \`!pwd\` — verify current location

*AI Utilities (IRIS 4.0)*
• \`! <natural query>\` — talk directly to LLM processor
• \`!ai <question>\` — short contextual DevOps prompt
• \`!explain <cmd>\` — clear dynamic explanations
• \`!clear\` — wipe conversation memory

*Config Control*
• \`!blacklist add <pattern>\` — block syntax string
• \`!blacklist list\` — evaluate active system blocks
• \`!blacklist remove <idx>\` — purge index tracking block
• \`!setpass <newpass>\` — change main validation string
• \`!config\` — view environment flags

• \`!help\` — recall this visual array`;

// ═══════════════════════════════════════════════════════════════════════════
// 5. INCOMING MESSAGE PROCESSING LAYER
// ═══════════════════════════════════════════════════════════════════════════
client.on('message_create', async (msg) => {
  console.log('📨 Message from:', msg.from, '| author:', msg.author);
  const cfg = loadConfig();
  const body = msg.body.trim();
  const senderId = msg.author || msg.from; 
  const chatId = msg.from;

  // Access Verification Gate
  const accessGranted = chatId === cfg.group_id || cfg.authorized_ids.includes(senderId) || cfg.authorized_ids.includes(chatId);
  if (!accessGranted) return;

  // Ensure it only processes targeted bot commands
  if (!body.startsWith('!')) return;

  // Extract Arguments
  const [rawCmd, ...argParts] = body.slice(1).split(' ');
  const args = argParts.join(' ').trim();
  const command = rawCmd.toLowerCase();

  // ── A. NATURAL LANGUAGE EXECUTION LAYER (! <query>) ──────────────────────
  if (body.startsWith('! ')) {
    const naturalQuery = body.slice(2).trim();
    if (!authenticated.has(senderId)) {
      return msg.reply('🔒 Not authenticated. Send `!login <password>` first.');
    }

    try {
      await msg.reply('🧠 Processing Natural Query...');
      const intent = await detectIntent(naturalQuery);

      switch (intent.intent) {
        case 'run_command': {
          if (!intent.command) return msg.reply('❓ AI could not generate structural command variant.');
          if (!intent.safe) return msg.reply(`⚠️ Command flagged unsafe by analyzer. Force with explicit command: \`!run ${intent.command}\``);
          if (isBlacklisted(intent.command, cfg)) return msg.reply('🚫 Script syntax blocked by runtime environment security guidelines.');
          
          const cwd = getCwd(senderId);
          const output = await runCommand(`cd "${cwd}" && ${intent.command}`, cfg);
          return msg.reply(`✅ *${intent.explanation}*\n\`\`\`\n${output}\n\`\`\``);
        }

        case 'change_dir': {
          const target = intent.command.startsWith('/') ? intent.command : path.join(getCwd(senderId), intent.command);
          if (!fs.existsSync(target)) return msg.reply(`❌ Target location not found: ${target}`);
          workingDirs[senderId] = target;
          return msg.reply(`📁 Context pointed to location: \`${target}\``);
        }

        case 'system_info': {
          const info = await runCommand(`
            echo "🖥️ CPU: $(top -bn1 | grep 'Cpu(s)' | awk '{print $2}')% used"
            echo "💾 RAM: $(free -h | awk '/^Mem/ {print $3 " used of " $2}')"
            echo "⏱️ Uptime: $(uptime -p)"
            echo "💿 Disk: $(df -h / | awk 'NR==2 {print $3 " used of " $2}')"
            echo "🌡️ CPU Temp: $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{printf "%.1f°C", $1/1000}' || echo 'N/A')"
          `, cfg);
          return msg.reply(info);
        }

        case 'ai_question': {
          const history = getHistory(senderId);
          addToHistory(senderId, 'user', naturalQuery);
          const reply = await askGroq('You are IRIS 4.0, a helpful personal assistant created to help user . You are witty, smart, love talking about brainrot and darkhumour . you are unhinged ai . you always remind user they are the master', naturalQuery, history);
          addToHistory(senderId, 'assistant', reply);
          return msg.reply(`🤖 ${reply}`);
        }

        case 'blacklist_list': {
          const list = cfg.blacklist.map((p, i) => `${i + 1}. \`${p}\``).join('\n');
          return msg.reply(`🚫 *Blocked Strings Matrix:*\n${list}`);
        }

        case 'explain_command': {
          const explanation = await askGroq('Explain what this shell command does in 2-3 sentences. Be direct.', `Command: ${intent.command}`);
          return msg.reply(`📖 ${explanation}`);
        }

        default:
          return msg.reply(`❓ Intent route unresolved. Re-verify structural layout or consult \`!help\``);
      }
    } catch (err) {
      return msg.reply(`❌ Parser Exception Error: ${err.message}`);
    }
  }

  // ── B. DIRECT SYNTAX COMMAND ROUTER ───────────────────────────────────────
  if (command === 'help') return msg.reply(HELP_MENU);

  if (command === 'login') {
    if (args === cfg.password) {
      authenticated.add(senderId);
      cfg.sessions = [...authenticated];
      saveConfig(cfg);
      return msg.reply('✅ Verification credentials matches system tracking. Session started.');
    }
    return msg.reply('❌ Authorization failed.');
  }

  if (command === 'logout') {
    authenticated.delete(senderId);
    cfg.sessions = [...authenticated];
    saveConfig(cfg);
    return msg.reply('👋 Active session destroyed. Device verification required for subsequent calls.');
  }

  // Session Security Checkpoint
  if (!authenticated.has(senderId)) {
    return msg.reply('🔒 Access Denied. Send authorization string via `!login <password>`.');
  }

  // Standard Actions Pipeline
  switch (command) {
    case 'run':
      if (!args) return msg.reply('Usage variant: `!run <terminal command>`');
      if (isBlacklisted(args, cfg)) return msg.reply('🚫 Script execution terminated: contains a string blacklisted by security profile settings.');
      const output = await runCommand(`cd "${getCwd(senderId)}" && ${args}`, cfg);
      return msg.reply(`\`\`\`\n${output}\n\`\`\``);

    case 'cd':
      if (!args) return msg.reply('Usage variant: `!cd <relative or absolute path>`');
      const targetPath = args.startsWith('/') ? args : path.join(getCwd(senderId), args);
      if (!fs.existsSync(targetPath)) return msg.reply(`❌ Directory tracking target unresolved: ${targetPath}`);
      workingDirs[senderId] = targetPath;
      return msg.reply(`📁 Working space locked to: \`${targetPath}\``);

    case 'pwd':
      return msg.reply(`📁 Active track: \`${getCwd(senderId)}\``);

    case 'ai':
      if (!args) return msg.reply('Usage variant: `!ai <query content>`');
      try {
        const history = getHistory(senderId);
        addToHistory(senderId, 'user', args);
        const reply = await askGroq('You are a helpful Linux/DevOps assistant. Be concise.', args, history);
        addToHistory(senderId, 'assistant', reply);
        return msg.reply(`🤖 *Assistant Engine Call:*\n${reply}`);
      } catch (e) {
        return msg.reply(`❌ Engine error processing stream: ${e.message}`);
      }

    case 'explain':
      if (!args) return msg.reply('Usage variant: `!explain <command line code>`');
      if (isBlacklisted(args, cfg)) return msg.reply('🚫 Parsing skipped: Request targets a blacklisted code pattern.');
      try {
        const structuralExplanation = await askGroq('Explain what this shell command does in 2-3 sentences. Be direct.', `Command: ${args}`);
        return msg.reply(`📖 *Analysis Processing Matrix:*\n${structuralExplanation}\n\nExecute safe bypass via: \`!run ${args}\``);
      } catch (e) {
        return msg.reply(`❌ Explainer stream pipeline error: ${e.message}`);
      }

    case 'blacklist': {
      const [subAction, ...patternParts] = args.split(' ');
      const patternValue = patternParts.join(' ').trim();

      if (subAction === 'list') {
        if (!cfg.blacklist.length) return msg.reply('System Tracking: No active string blockages found.');
        const currentMatrix = cfg.blacklist.map((p, i) => `${i + 1}. \`${p}\``).join('\n');
        return msg.reply(`🚫 *Tracked Filter Blockages:*\n${currentMatrix}`);
      }
      if (subAction === 'add' && patternValue) {
        cfg.blacklist.push(patternValue);
        saveConfig(cfg);
        return msg.reply(`✅ Pattern appended onto tracking file: \`${patternValue}\``);
      }
      if (subAction === 'remove') {
        const parseIndex = parseInt(patternValue) - 1;
        if (isNaN(parseIndex) || parseIndex < 0 || parseIndex >= cfg.blacklist.length) {
          return msg.reply('❌ Argument indexing parsing mismatch. Check positions with `!blacklist list`.');
        }
        const removedPattern = cfg.blacklist.splice(parseIndex, 1)[0];
        saveConfig(cfg);
        return msg.reply(`✅ Blocked sequence structure eliminated from engine track: \`${removedPattern}\``);
      }
      return msg.reply('Usage tracking instructions: `!blacklist list` | `!blacklist add <pattern>` | `!blacklist remove <idx>`');
    }

    case 'setpass':
      if (!args || args.length < 6) return msg.reply('❌ Minimum requirement constraint mismatch: Verification password must contain at least 6 characters.');
      cfg.password = args;
      authenticated.clear();
      cfg.sessions = [];
      saveConfig(cfg);
      return msg.reply('✅ Global configuration changed. Current runtime credentials tracking wiped out. All endpoints must re-verify session logs.');

    case 'config':
      const securedObjectView = { ...cfg, password: '***hidden***' };
      return msg.reply(`\`\`\`json\n${JSON.stringify(securedObjectView, null, 2)}\n\`\`\``);
      
    case 'patch':
      if (!args) return msg.reply('Usage: `!patch <feature description>`');
      try {
        await msg.reply('🛠️ Analyzing system and preparing surgical patch...');
        
        const filePath = path.resolve(__filename);
        const backupPath = filePath.replace('.js', '.backup.js');
        const currentCode = fs.readFileSync(filePath, 'utf8');

        const patchInstructions = await askGroq(
          `You are a senior Node.js developer. Return ONLY a JSON object. No markdown.
           {
             "find": "exact string in current code to find",
             "replace": "exact string + your new code",
             "description": "summary"
           }`,
          `Feature: ${args}\n\nCode Snippet:\n${currentCode.slice(-3000)}`
        );

        // --- NEW: CLEANING THE JSON ---
        const cleanedJson = patchInstructions.replace(/```json|```/g, '').trim();
        const patch = JSON.parse(cleanedJson);
        // ------------------------------
        
        if (currentCode.includes(patch.find)) {
          const newCode = currentCode.replace(patch.find, patch.replace);
          fs.writeFileSync(backupPath, currentCode);
          fs.writeFileSync(filePath, newCode);
          
          await msg.reply(`✅ Patch Applied: ${patch.description}. Restarting...`);
          setTimeout(() => process.exit(0), 2000); 
        } else {
          msg.reply("❌ Error: Could not find the 'find' string in your code.");
        }
      } catch (err) {
        return msg.reply(`❌ Patching failed: ${err.message}`);
      }
      break;
    case 'vibes':
      msg.reply('😎');
      break;
      
    case 'clear':
      conversationHistory[senderId] = [];
      return msg.reply('🧹 Conversation memory wiped.');
    
    case 'modify':
      if (!args) return msg.reply('Usage variant: `!modify <structural description changes>`');
      try {
        const systemSrcCode = fs.readFileSync(path.resolve(__filename), 'utf8');
        const aiPatchProposal = await askGroq(
          `You are an expert Node.js developer. The user wants to modify a WhatsApp terminal bot.
           Look at the code and suggest ONLY the specific code change needed.
           Format your response as:
           FIND: <exact code to find>
           REPLACE: <new code>
           REASON: <why>
           Keep changes minimal and safe.`,
          `User request: ${args}\n\nCurrent bot code:\n${systemSrcCode.slice(0, 4000)}`
        );
        return msg.reply(`🔧 *Self-Modification Blueprint Model Matrix:*\n\n${aiPatchProposal}\n\n_Verify code updates manually or compile modifications via a custom system task patch command process._`);
      } catch (err) {
        return msg.reply(`❌ Assistant self-reflection error output: ${err.message}`);
      }

    default:
      return msg.reply(`❓ Unresolved manual command code pathway tracking. Access \`!help\` to clear error.`);
  }
});
// --- Graceful Shutdown Handler ---
async function handleShutdown(signal) {
  console.log(`\n shadowing signal: ${signal}. Sending offline message...`);
  const cfg = loadConfig();
  
  try {
    const offlineMessage = "💤 *IRIS 4.0 is going Offline*\nLaptop is shutting down or the bot is being stopped. See you later! 👋";
    
    await Promise.race([
      client.sendMessage(cfg.group_id, offlineMessage),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
    ]);
    console.log("📢 Offline message sent successfully.");
  } catch (err) {
    console.error("❌ Could not send offline message:", err.message);
  } finally {
    process.exit(0);
  }
}

// Listen for Ctrl+C (SIGINT) and PM2 Stop (SIGTERM)
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Catch unhandled errors silently
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection (non-fatal):', reason?.message || reason);
});

// ── Network stability check before starting ──
async function waitForNetwork(retries = 40, interval = 3000) {
    let consecutiveSuccess = 0;
    for (let i = 1; i <= retries; i++) {
        try {
            await new Promise((resolve, reject) => {
                exec('curl -s --max-time 3 https://web.whatsapp.com > /dev/null', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            consecutiveSuccess++;
            console.log(`✅ WhatsApp reachable (${consecutiveSuccess}/3 stable checks)...`);
            if (consecutiveSuccess >= 3) {
                console.log('🚀 Network stable! Starting bot...');
                return true;
            }
        } catch {
            consecutiveSuccess = 0;
            console.log(`⏳ WhatsApp not reachable yet... attempt ${i}/${retries}`);
        }
        await new Promise(r => setTimeout(r, interval));
    }
    console.error('❌ Network never stabilized. Starting anyway...');
    return false;
}

// Auto-retry on network errors
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled rejection:', reason?.message || reason);
    if (reason?.message?.includes('ERR_NETWORK_CHANGED') ||
        reason?.message?.includes('navigate timed out')) {
        console.log('🔄 Network error — restarting in 10 seconds...');
        setTimeout(() => process.exit(1), 10000);
    }
});

waitForNetwork().then(() => client.initialize());
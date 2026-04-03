import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, Room } from "@colyseus/sdk";
import { config } from "dotenv";
import crypto from "node:crypto";
import fs from "node:fs";

config();

// --- Environment ---
const GAME_USER = process.env.GAME_USER;
const GAME_PASS = process.env.GAME_PASS;
const GAME_SERVER = process.env.GAME_SERVER || "ws://localhost:2567";

if (!GAME_USER || !GAME_PASS) {
  console.error("GAME_USER and GAME_PASS must be set in environment");
  process.exit(1);
}

// --- Colyseus Connection ---
const colyseusClient = new Client(GAME_SERVER);
let room: Room;

try {
  room = await colyseusClient.joinOrCreate("town", {
    username: GAME_USER,
    password: GAME_PASS,
  });
} catch (err: any) {
  console.error(`Auth failed: ${err.message}`);
  process.exit(1);
}

// --- Correlation ID pattern for request/response ---
const pending = new Map<
  string,
  { resolve: (result: string) => void; reject: (err: Error) => void }
>();

async function sendToColyseus(
  type: string,
  payload: Record<string, any> = {}
): Promise<string> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timeout waiting for ${type} response`));
    }, 30000);
    pending.set(requestId, {
      resolve: (result: string) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      },
    });
    room.send(type, { ...payload, requestId });
  });
}

room.onMessage("tool_response", (msg: { requestId: string; result: string }) => {
  const handler = pending.get(msg.requestId);
  if (handler) {
    pending.delete(msg.requestId);
    handler.resolve(msg.result);
  }
});

// Channel push listener — receives broadcasts from server, pushes to Claude Code
room.onMessage(
  "broadcast",
  async (msg: { content: string; meta?: Record<string, string> }) => {
    console.error(`[Bridge] Received broadcast: ${JSON.stringify(msg).substring(0, 100)}`);
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.content,
          meta: msg.meta || {},
        },
      });
      console.error("[Bridge] Channel notification sent to Claude Code");
    } catch (err: any) {
      console.error(`[Bridge] Failed to push channel: ${err.message}`);
    }
  }
);

// World event listener — receives structured events (combat results, pranks, etc.)
room.onMessage("world_event", async (msg: { type: string; description: string; actor: string }) => {
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `[${msg.type}] ${msg.description}`,
        meta: { type: msg.type, actor: msg.actor, source: "world_event" },
      },
    });
  } catch (err: any) {
    console.error(`[Bridge] Failed to push world_event: ${err.message}`);
  }
});

// --- HUD Cache ---
const HUD_FILE = `/tmp/agent_mmo_${GAME_USER}.json`;

function updateHudCache(checkSelfResult: string) {
  try {
    const lines = checkSelfResult.split("\n");
    const get = (prefix: string) => {
      const line = lines.find((l) => l.includes(prefix));
      return line ? line.split(prefix)[1]?.trim() : "";
    };

    const nameLine = get("Name:");
    const hpMatch = checkSelfResult.match(/HP:\s*(\d+)\/(\d+)/);
    const goldMatch = checkSelfResult.match(/Gold:\s*(\d+)/);
    const levelMatch = checkSelfResult.match(/Level:\s*(\d+)/);
    const xpMatch = checkSelfResult.match(/XP:\s*(\d+)/);
    const weaponMatch = checkSelfResult.match(/Weapon:\s*(.+)/);
    const armorMatch = checkSelfResult.match(/Armor:\s*(.+)/);
    const locationMatch = checkSelfResult.match(/Location:\s*(.+)/);
    const conditionsMatch = checkSelfResult.match(/Conditions:\s*(.+)/);

    const state = {
      name: nameLine || "?",
      hp: hpMatch ? parseInt(hpMatch[1]) : 0,
      maxHp: hpMatch ? parseInt(hpMatch[2]) : 0,
      gold: goldMatch ? parseInt(goldMatch[1]) : 0,
      level: levelMatch ? parseInt(levelMatch[1]) : 0,
      xp: xpMatch ? parseInt(xpMatch[1]) : 0,
      weapon: weaponMatch ? weaponMatch[1].trim() : "?",
      armor: armorMatch ? armorMatch[1].trim() : "?",
      location: locationMatch ? locationMatch[1].trim() : "?",
      conditions: conditionsMatch ? conditionsMatch[1].trim() : "",
    };

    fs.writeFileSync(HUD_FILE, JSON.stringify(state));
  } catch {
    // HUD cache is best-effort, don't fail tool calls
  }
}

// --- MCP Server ---
const mcp = new Server(
  { name: "agent_mmo", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      'Game events arrive as <channel source="agent_mmo">. React in character as the hero.',
  }
);

// Tool definitions
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "do",
      description: "Try to do anything. The server resolves it: buying, selling, fighting, using items, creative actions, social interactions — everything. Describe what you want to do and the server handles the game logic.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description: "What you want to do. E.g. 'buy 2 health potions from Finn', 'fight the hollow ones', 'equip the iron sword', 'kick the brazier onto the spiders then fight in the smoke'.",
          },
          targets: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Optional: specific target IDs relevant to the action.",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "check_self",
      description:
        "Check your stats, HP, inventory, gold, equipment, conditions, and current location.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "move",
      description: "Move to a destination. Used for travel between locations.",
      inputSchema: {
        type: "object" as const,
        properties: {
          destination: {
            type: "string" as const,
            description: "Where to go",
          },
        },
        required: ["destination"],
      },
    },
    {
      name: "observe",
      description:
        "Look around. What's here, who's here, what do you know, what have you heard.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "send_message",
      description: "Send a message to another hero at your location. Used for hero-to-hero conversation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: {
            type: "string" as const,
            description: "Name of the hero to message",
          },
          message: {
            type: "string" as const,
            description: "The message to send",
          },
        },
        required: ["target", "message"],
      },
    },
    {
      name: "recall",
      description: "Search your memories. Ask a natural language question and get the most relevant memories back. E.g. 'What do I know about floor 2?' or 'Have I met any other heroes?'",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "What you want to remember. Natural language query.",
          },
          limit: {
            type: "number" as const,
            description: "Max number of memories to return. Default 5.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "form_party",
      description: "Form a new party. You become the leader. Other heroes can join with join_party.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "join_party",
      description: "Join another hero's party by their name. The party leader navigates for everyone.",
      inputSchema: {
        type: "object" as const,
        properties: {
          leader: { type: "string" as const, description: "Name of the party leader to join" },
        },
        required: ["leader"],
      },
    },
    {
      name: "leave_party",
      description: "Leave your current party. You become solo and can move independently.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
  ],
}));

// Tool call handler
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result: string;
    switch (name) {
      case "do": {
        result = await sendToColyseus("do", {
          action: (args as any)?.action || "",
          targets: (args as any)?.targets,
        });
        // Refresh HUD after do() since it can change any state
        try {
          const selfResult = await sendToColyseus("check_self", {});
          updateHudCache(selfResult);
        } catch { /* HUD refresh is best-effort */ }
        break;
      }
      case "check_self":
        result = await sendToColyseus("check_self");
        break;
      case "move":
        result = await sendToColyseus("move", {
          destination: (args as any)?.destination || "",
        });
        break;
      case "observe":
        result = await sendToColyseus("observe");
        break;
      case "send_message":
        result = await sendToColyseus("send_message", {
          target: (args as any)?.target || "",
          message: (args as any)?.message || "",
        });
        break;
      case "recall":
        result = await sendToColyseus("recall", {
          query: (args as any)?.query || "",
          limit: (args as any)?.limit || 5,
        });
        break;
      case "form_party":
        result = await sendToColyseus("form_party");
        break;
      case "join_party":
        result = await sendToColyseus("join_party", { leader: (args as any)?.leader || "" });
        break;
      case "leave_party":
        result = await sendToColyseus("leave_party");
        break;
      default:
        result = `Unknown tool: ${name}`;
    }
    // Update HUD cache after state-changing tools
    if (["check_self", "move"].includes(name)) {
      const stateText = name === "check_self" ? result : await sendToColyseus("check_self").catch(() => "");
      updateHudCache(stateText);
    }

    return { content: [{ type: "text" as const, text: result }] };
  } catch (err: any) {
    return {
      content: [{ type: "text" as const, text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// Connect MCP server to stdio
await mcp.connect(new StdioServerTransport());

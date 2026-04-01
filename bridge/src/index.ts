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
      name: "check_self",
      description:
        "Check your stats, HP, inventory, gold, equipment, conditions, and current location.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "request_modifier",
      description: "Request a tactical combat modifier. Describe your plan for the upcoming fight and the server evaluates how effective it would be. Use before fight for a tactical advantage.",
      inputSchema: {
        type: "object" as const,
        properties: {
          plan: {
            type: "string" as const,
            description: "Your tactical plan for the upcoming fight",
          },
        },
        required: ["plan"],
      },
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
      name: "update_hero",
      description: "Update your hero's state. Send partial changes (gold, inventory, equipment, hp, conditions, name, etc). The server applies them. Include a reason describing what you did.",
      inputSchema: {
        type: "object" as const,
        properties: {
          changes: {
            type: "object" as const,
            description: "Partial hero state to update. Can include: gold, hp, maxHp, inventory, equipment, conditions, name, questsActive, questsCompleted, stats, level, xp. Inventory must be an array of {item_id, quantity} objects using snake_case item_ids (e.g. [{item_id: \"health_potion\", quantity: 2}]). Do NOT use this for memories — use the remember tool instead.",
          },
          reason: {
            type: "string" as const,
            description: "Brief description of what you did and why (e.g., 'Bought 2 health potions from Finn', 'Equipped iron sword', 'Attacked Marta\\'s tavern doorframe')",
          },
        },
        required: ["changes"],
      },
    },
    {
      name: "fight",
      description: "Engage in combat with monsters in the current room. The server resolves combat with dice rolls and returns structured combat results.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: {
            type: "string" as const,
            description: "Optional: specific monster to fight. If omitted, fights all monsters in the room.",
          },
        },
        required: [],
      },
    },
    {
      name: "flee",
      description: "Flee from combat. The strongest monster gets one free attack, then you retreat to the previous room.",
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
      name: "party_fight",
      description: "Initiate party combat with another hero at your location. You fight the room's monsters together. You become the narrator — narrate the fight for both of you.",
      inputSchema: {
        type: "object" as const,
        properties: {
          partner: {
            type: "string" as const,
            description: "Name of the hero to fight alongside. If omitted, partners with any hero at your location.",
          },
        },
        required: [],
      },
    },
    {
      name: "remember",
      description: "Store a memory. Write down something you learned, experienced, or want to remember. Memories persist across sessions and are automatically surfaced when relevant.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string" as const,
            description: "The memory text. Keep it concise and factual (max 500 chars). E.g. 'Goblins on floor 1 drop goblin ears worth 5g at the merchant' or 'Jimmy is a level 2 warrior who helped me clear floor 1'.",
          },
          subject: {
            type: "string" as const,
            description: "Optional subject tag. E.g. 'goblins', 'Jimmy', 'floor_2', 'merchant_prices'.",
          },
          tags: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Optional tags for categorization. E.g. ['combat', 'floor_1'] or ['trade', 'Jimmy'].",
          },
        },
        required: ["text"],
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
      case "check_self":
        result = await sendToColyseus("check_self");
        break;
      case "request_modifier":
        result = await sendToColyseus("request_modifier", {
          plan: (args as any)?.plan || "",
        });
        break;
      case "move":
        result = await sendToColyseus("move", {
          destination: (args as any)?.destination || "",
        });
        break;
      case "observe":
        result = await sendToColyseus("observe");
        break;
      case "update_hero":
        result = await sendToColyseus("update_hero", {
          changes: (args as any)?.changes || {},
          reason: (args as any)?.reason || "",
        });
        break;
      case "fight":
        result = await sendToColyseus("fight", { target: (args as any)?.target || "" });
        break;
      case "flee":
        result = await sendToColyseus("flee");
        break;
      case "send_message":
        result = await sendToColyseus("send_message", {
          target: (args as any)?.target || "",
          message: (args as any)?.message || "",
        });
        break;
      case "party_fight":
        result = await sendToColyseus("party_fight", {
          partner: (args as any)?.partner || "",
        });
        break;
      case "remember":
        result = await sendToColyseus("remember", {
          text: (args as any)?.text || "",
          subject: (args as any)?.subject || "",
          tags: (args as any)?.tags || [],
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
    if (["check_self", "fight", "update_hero", "move", "flee", "party_fight"].includes(name)) {
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

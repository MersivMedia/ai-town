import { Id, TableNames } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  DatabaseReader,
  internalAction,
  internalMutation,
  mutation,
  query,
  internalQuery,
} from './_generated/server';
import { v } from 'convex/values';
import schema from './schema';
import { DELETE_BATCH_SIZE } from './constants';
import { kickEngine, startEngine, stopEngine } from './aiTown/main';
import { insertInput } from './aiTown/insertInput';
import { fetchEmbedding, LLM_CONFIG } from './util/llm';
import { chatCompletion } from './util/llm';
import { startConversationMessage } from './agent/conversation';
import { GameId } from './aiTown/ids';
import getOrCreateDefaultWorld from './init';

// Clear all of the tables except for the embeddings cache.
const excludedTables: Array<TableNames> = ['embeddingsCache'];

export const wipeAllTables = internalMutation({
  handler: async (ctx) => {
    for (const tableName of Object.keys(schema.tables)) {
      if (excludedTables.includes(tableName as TableNames)) {
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.testing.deletePage, { tableName, cursor: null });
    }
  },
});

export const deletePage = internalMutation({
  args: {
    tableName: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query(args.tableName as TableNames)
      .paginate({ cursor: args.cursor, numItems: DELETE_BATCH_SIZE });
    for (const row of results.page) {
      await ctx.db.delete(row._id);
    }
    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.testing.deletePage, {
        tableName: args.tableName,
        cursor: results.continueCursor,
      });
    }
  },
});

export const kick = internalMutation({
  handler: async (ctx) => {
    const { worldStatus } = await getDefaultWorld(ctx.db);
    await kickEngine(ctx, worldStatus.worldId);
  },
});

export const stopAllowed = query({
  handler: async () => {
    return !process.env.STOP_NOT_ALLOWED;
  },
});

export const stop = mutation({
  handler: async (ctx) => {
    if (process.env.STOP_NOT_ALLOWED) throw new Error('Stop not allowed');
    const { worldStatus, engine } = await getDefaultWorld(ctx.db);
    if (worldStatus.status === 'inactive' || worldStatus.status === 'stoppedByDeveloper') {
      if (engine.running) {
        throw new Error(`Engine ${engine._id} isn't stopped?`);
      }
      console.debug(`World ${worldStatus.worldId} is already inactive`);
      return;
    }
    console.log(`Stopping engine ${engine._id}...`);
    await ctx.db.patch(worldStatus._id, { status: 'stoppedByDeveloper' });
    await stopEngine(ctx, worldStatus.worldId);
  },
});

export const resume = mutation({
  handler: async (ctx) => {
    const { worldStatus, engine } = await getDefaultWorld(ctx.db);
    if (worldStatus.status === 'running') {
      if (!engine.running) {
        throw new Error(`Engine ${engine._id} isn't running?`);
      }
      console.debug(`World ${worldStatus.worldId} is already running`);
      return;
    }
    console.log(
      `Resuming engine ${engine._id} for world ${worldStatus.worldId} (state: ${worldStatus.status})...`,
    );
    await ctx.db.patch(worldStatus._id, { status: 'running' });
    await startEngine(ctx, worldStatus.worldId);
  },
});

export const archive = internalMutation({
  handler: async (ctx) => {
    const { worldStatus, engine } = await getDefaultWorld(ctx.db);
    if (engine.running) {
      throw new Error(`Engine ${engine._id} is still running!`);
    }
    console.log(`Archiving world ${worldStatus.worldId}...`);
    await ctx.db.patch(worldStatus._id, { isDefault: false });
  },
});

async function getDefaultWorld(db: DatabaseReader) {
  const worldStatus = await db
    .query('worldStatus')
    .filter((q) => q.eq(q.field('isDefault'), true))
    .first();
  if (!worldStatus) {
    throw new Error('No default world found');
  }
  const engine = await db.get(worldStatus.engineId);
  if (!engine) {
    throw new Error(`Engine ${worldStatus.engineId} not found`);
  }
  return { worldStatus, engine };
}

export const debugCreatePlayers = internalMutation({
  args: {
    numPlayers: v.number(),
  },
  handler: async (ctx, args) => {
    const { worldStatus } = await getDefaultWorld(ctx.db);
    for (let i = 0; i < args.numPlayers; i++) {
      const inputId = await insertInput(ctx, worldStatus.worldId, 'join', {
        name: `Robot${i}`,
        description: `This player is a robot.`,
        character: `f${1 + (i % 8)}`,
      });
    }
  },
});

export const randomPositions = internalMutation({
  handler: async (ctx) => {
    const { worldStatus } = await getDefaultWorld(ctx.db);
    const map = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', worldStatus.worldId))
      .unique();
    if (!map) {
      throw new Error(`No map for world ${worldStatus.worldId}`);
    }
    const world = await ctx.db.get(worldStatus.worldId);
    if (!world) {
      throw new Error(`No world for world ${worldStatus.worldId}`);
    }
    for (const player of world.players) {
      await insertInput(ctx, world._id, 'moveTo', {
        playerId: player.id,
        destination: {
          x: 1 + Math.floor(Math.random() * (map.width - 2)),
          y: 1 + Math.floor(Math.random() * (map.height - 2)),
        },
      });
    }
  },
});

export const testEmbedding = internalAction({
  args: { input: v.string() },
  handler: async (_ctx, args) => {
    return await fetchEmbedding(args.input);
  },
});

export const testCompletion = internalAction({
  args: {},
  handler: async (ctx, args) => {
    return await chatCompletion({
      messages: [
        { content: 'You are helpful', role: 'system' },
        { content: 'Where is pizza?', role: 'user' },
      ],
    });
  },
});

export const testConvo = internalAction({
  args: {},
  handler: async (ctx, args) => {
    const a: any = (await startConversationMessage(
      ctx,
      'm1707m46wmefpejw1k50rqz7856qw3ew' as Id<'worlds'>,
      'c:115' as GameId<'conversations'>,
      'p:0' as GameId<'players'>,
      'p:6' as GameId<'players'>,
    )) as any;
    return await a.readAll();
  },
});

export const testMessageGeneration = internalAction({
  handler: async (ctx): Promise<void> => {
    console.log("\n=== Testing Message Generation ===");
    
    try {
      const worldId = 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>;
      const conversationId = 'c:54';  // Match the UI's conversation ID
      
      // 1. First message
      const msg1 = await ctx.runMutation(internal.testing.addTestMessage, {
        worldId,
        conversationId,
        text: "Hello! How are you today?",
        messageUuid: "test-1",
        author: "p:0"
      });
      console.log("1. First message created:", msg1);

      // 2. Response
      const msg2 = await ctx.runMutation(internal.testing.addTestMessage, {
        worldId,
        conversationId,
        text: "I'm doing great, thanks for asking!",
        messageUuid: "test-2",
        author: "p:6"
      });
      console.log("2. Response created:", msg2);

      // 3. Verify messages exist
      const messages = await ctx.runQuery(internal.testing.getConversationMessages, {
        worldId,
        conversationId
      });
      console.log("3. Messages in conversation:", messages);
      
    } catch (error) {
      console.error("Error creating test messages:", error);
      throw error;
    }
  }
});

// Helper mutation to ensure world exists
export const ensureWorld = internalMutation({
  args: {
    worldId: v.id('worlds')
  },
  handler: async (ctx, args): Promise<Id<'worlds'>> => {
    const existing = await ctx.db.get(args.worldId);
    if (!existing) {
      await ctx.db.insert('worlds', {
        players: [],
        agents: [],
        conversations: [],
        historicalLocations: [],
        nextId: 0
      });
      await ctx.db.patch(args.worldId, {});
    }
    return args.worldId;
  }
});

// Helper mutation to ensure player descriptions exist
export const ensurePlayerDescription = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId: v.string(),
    name: v.string(),
    description: v.string(),
    character: v.string()
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', q => 
        q.eq('worldId', args.worldId)
         .eq('playerId', args.playerId)
      )
      .first();

    if (!existing) {
      await ctx.db.insert('playerDescriptions', {
        worldId: args.worldId,
        playerId: args.playerId,
        name: args.name,
        description: args.description,
        character: args.character
      });
    }
  }
});

export const testMessageDelivery = internalAction({
  handler: async (ctx): Promise<void> => {
    console.log("\n=== Testing Message Delivery System ===");
    
    try {
      // 1. First agent starts conversation
      const message1Id = await ctx.runMutation(internal.testing.addTestMessage, {
        worldId: 'm1707m46wmefpejw1k50rqz7856qw3ew' as Id<'worlds'>,
        conversationId: 'c:115',
        text: "Hi there! How are you today?",
        messageUuid: "test-1",
        author: "p:0"
      });
      console.log("1. First message sent:", message1Id);

      // 2. Second agent responds
      const message2Id = await ctx.runMutation(internal.testing.addTestMessage, {
        worldId: 'm1707m46wmefpejw1k50rqz7856qw3ew' as Id<'worlds'>,
        conversationId: 'c:115',
        text: "Hello! I'm doing great, thanks for asking!",
        messageUuid: "test-2",
        author: "p:6"
      });
      console.log("2. Response sent:", message2Id);

      // 3. Get all messages in the conversation
      const conversationMessages = await ctx.runQuery(internal.testing.getConversationMessages, {
        worldId: 'm1707m46wmefpejw1k50rqz7856qw3ew' as Id<'worlds'>,
        conversationId: 'c:115'
      });
      console.log("3. Full conversation:", conversationMessages);

    } catch (error) {
      console.error("Error in message delivery test:", error);
      throw error;
    }
  }
});

export const addTestMessage = internalMutation({
  args: {
    worldId: v.id('worlds'),
    conversationId: v.string(),
    text: v.string(),
    messageUuid: v.string(),
    author: v.string()
  },
  handler: async (ctx, args): Promise<Id<'messages'>> => {
    return await ctx.db.insert('messages', {
      worldId: args.worldId,
      conversationId: args.conversationId,
      text: args.text,
      messageUuid: args.messageUuid,
      author: args.author
    });
  }
});

export const getTestMessage = internalQuery({
  args: {
    messageId: v.id('messages')
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.messageId);
  }
});

export const getConversationMessages = internalQuery({
  args: {
    conversationId: v.string(),
    worldId: v.id('worlds')
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query('messages')
      .filter(q => 
        q.and(
          q.eq(q.field('worldId'), args.worldId),
          q.eq(q.field('conversationId'), args.conversationId)
        )
      )
      .order('desc')
      .collect();
    
    console.log(`Found ${messages.length} messages for conversation ${args.conversationId}`);
    return messages;
  }
});

// Test function to check what the frontend would see
export const testFrontendView = internalAction({
  handler: async (ctx): Promise<void> => {
    console.log("\n=== Testing Frontend Data Access ===");
    
    const worldId = 'm1707m46wmefpejw1k50rqz7856qw3ew' as Id<'worlds'>;
    
    // 1. Get all conversations for the world
    const conversations = await ctx.runQuery(internal.testing.getWorldConversations, {
      worldId
    });
    console.log("1. World conversations:", conversations);

    // 2. Get messages for a specific conversation
    const messages = await ctx.runQuery(internal.testing.getConversationMessages, {
      worldId,
      conversationId: 'c:115'
    });
    console.log("2. Conversation messages:", messages);
  }
});

export const getWorldConversations = internalQuery({
  args: {
    worldId: v.id('worlds')
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query('messages')
      .filter(q => q.eq(q.field('worldId'), args.worldId))
      .collect();

    const conversationIds = [...new Set(messages.map(m => m.conversationId))];
    return conversationIds;
  }
});

export const testAgentSystem = internalAction({
  handler: async (ctx): Promise<void> => {
    console.log("\n=== Testing Agent System ===");
    
    try {
      // 1. Create test agents
      const agent1Id = await ctx.runMutation(internal.testing.debugCreatePlayers, {
        numPlayers: 1
      });
      console.log("1. Created test agent:", agent1Id);

      // 2. Check agent state
      const agentState = await ctx.runQuery(internal.testing.getAgentConversations, {
        worldId: 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>,
        playerId: 'p:0'
      });
      console.log("2. Agent state:", agentState);

      // 3. Generate message and store conversation
      const result = await ctx.runMutation(internal.testing.storeAgentConversation, {
        worldId: 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>,
        initiatorId: 'p:0',
        targetId: 'p:6',
        message: "Hi there! How are you today?"
      });
      console.log("3. Conversation result:", result);

    } catch (error) {
      console.error("Error in agent system test:", error);
      throw error;
    }
  }
});

export const storeAgentConversation = internalMutation({
  args: {
    worldId: v.id('worlds'),
    initiatorId: v.string(),
    targetId: v.string(),
    message: v.string()
  },
  handler: async (ctx, args) => {
    const conversationId = `c:${Date.now()}`;
    
    // Store the message
    const messageId = await ctx.db.insert('messages', {
      worldId: args.worldId,
      conversationId,
      text: args.message,
      messageUuid: `${Date.now()}-${args.initiatorId}`,
      author: args.initiatorId
    });

    return {
      conversationId,
      messageId,
      message: args.message
    };
  }
});

// Add these helper functions
export const getAgentState = internalQuery({
  args: {
    playerId: v.string()
  },
  handler: async (ctx, args) => {
    // Get agent description
    const description = await ctx.db
      .query('playerDescriptions')
      .filter(q => q.eq(q.field('playerId'), args.playerId))
      .first();

    // Get agent's recent conversations
    const recentMessages = await ctx.db
      .query('messages')
      .filter(q => q.eq(q.field('author'), args.playerId))
      .order('desc')
      .take(5);

    return {
      description,
      recentMessages,
      // Add other relevant state info
    };
  }
});

export const initiateAgentConversation = internalMutation({
  args: {
    worldId: v.id('worlds'),
    initiatorId: v.string(),
    targetId: v.string()
  },
  handler: async (ctx, args) => {
    // Create a new conversation ID
    const conversationId = `c:${Date.now()}`;

    // Generate initial message using chatCompletion
    const { content: initialMessage } = await chatCompletion({
      messages: [
        {
          role: "system",
          content: `You are an AI agent in a virtual world. Your ID is ${args.initiatorId}. Start a conversation with agent ${args.targetId}.`
        },
        {
          role: "user",
          content: "Generate a friendly conversation starter."
        }
      ],
      max_tokens: 300
    });

    // Store the message
    const messageId = await ctx.db.insert('messages', {
      worldId: args.worldId,
      conversationId,
      text: initialMessage,
      messageUuid: `${Date.now()}-${args.initiatorId}`,
      author: args.initiatorId
    });

    return {
      conversationId,
      messageId,
      initialMessage
    };
  }
});

export const testWorldData = internalQuery({
  handler: async (ctx) => {
    const worlds = await ctx.db.query('worlds').collect();
    console.log("Available worlds:", worlds);
    
    if (worlds.length > 0) {
      const firstWorld = worlds[0];
      console.log("First world details:", firstWorld);
    }
    return worlds;
  }
});

export const testConversationDisplay = internalAction({
  handler: async (ctx): Promise<void> => {
    console.log("\n=== Testing Conversation Display Logic ===");
    
    const worldId = 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>; // Using the world ID we see in the working map

    try {
      // 1. Check active conversations
      const activeConvos = await ctx.runQuery(internal.testing.getActiveConversations, {
        worldId
      });
      console.log("1. Active conversations:", activeConvos);

      // 2. Check specific agents' conversations
      const agent1Convos = await ctx.runQuery(internal.testing.getAgentConversations, {
        worldId,
        playerId: 'p:0'
      });
      console.log("2. Agent p:0 conversations:", agent1Convos);

      // 3. Check most recent messages
      const recentMessages = await ctx.runQuery(internal.testing.getRecentMessages, {
        worldId,
        limit: 5
      });
      console.log("3. Recent messages:", recentMessages);

    } catch (error) {
      console.error("Error testing conversation display:", error);
      throw error;
    }
  }
});

// Helper queries
export const getActiveConversations = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query('messages')
      .filter(q => q.eq(q.field('worldId'), args.worldId))
      .order('desc')
      .collect();

    return [...new Set(messages.map(m => m.conversationId))];
  }
});

export const getAgentConversations = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId: v.string()
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query('messages')
      .filter(q => 
        q.and(
          q.eq(q.field('worldId'), args.worldId),
          q.eq(q.field('author'), args.playerId)
        )
      )
      .collect();
    
    console.log(`Found ${messages.length} messages for agent ${args.playerId}`);
    return messages;
  }
});

export const getRecentMessages = internalQuery({
  args: { 
    worldId: v.id('worlds'),
    limit: v.number()
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('messages')
      .filter(q => q.eq(q.field('worldId'), args.worldId))
      .order('desc')
      .take(args.limit);
  }
});

export const generateTestConversations = internalAction({
  handler: async (ctx): Promise<void> => {
    console.log("\n=== Generating Test Conversations ===");
    
    const worldId = 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>;
    
    // Conversation 1: Basic greeting
    const conv1 = await ctx.runMutation(internal.testing.addTestMessage, {
      worldId,
      conversationId: 'c:54',
      text: "Hi! I'm new here. How are you?",
      messageUuid: "conv1-1",
      author: "p:0"
    });
    console.log("Created greeting message:", conv1);

    // Conversation 2: Different topic
    const conv2 = await ctx.runMutation(internal.testing.addTestMessage, {
      worldId,
      conversationId: 'c:55',
      text: "Have you seen the garden? It's beautiful today!",
      messageUuid: "conv2-1",
      author: "p:6"
    });
    console.log("Created garden message:", conv2);

    // Check conversations
    const conversations = await ctx.runQuery(internal.testing.getActiveConversations, {
      worldId
    });
    console.log("Active conversations:", conversations);
  }
});

export const debugConversationIds = internalQuery({
  handler: async (ctx) => {
    const worldId = 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>;
    
    // Get world data with conversations
    const world = await ctx.db.get(worldId);
    console.log("1. Active conversations:", world?.conversations);
    
    // Get messages
    const messages = await ctx.db
      .query('messages')
      .filter(q => q.eq(q.field('worldId'), worldId))
      .collect();
    console.log("2. Messages:", messages);
    
    return { world, messages };
  }
});

export const setupTestConversation = internalMutation({
  handler: async (ctx) => {
    const worldId = 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>;
    
    // 1. Get character descriptions
    const binance = await ctx.db
      .query('playerDescriptions')
      .filter(q => q.eq(q.field('worldId'), worldId))
      .filter(q => q.eq(q.field('name'), 'Binance'))
      .first();
    
    const ethereum = await ctx.db
      .query('playerDescriptions')
      .filter(q => q.eq(q.field('worldId'), worldId))
      .filter(q => q.eq(q.field('name'), 'Ethereum'))
      .first();

    if (!binance || !ethereum) {
      throw new Error("Couldn't find Binance or Ethereum");
    }

    // 2. Create a new private conversation
    const world = await ctx.db.get(worldId);
    if (!world) throw new Error("World not found");

    // Use a unique conversation ID to avoid mixing with existing chats
    const conversationId = `private:${binance.playerId}:${ethereum.playerId}`;
    const newConversation = {
      created: Date.now(),
      creator: binance.playerId,
      id: conversationId,
      numMessages: 2,
      participants: [
        {
          invited: Date.now(),
          playerId: binance.playerId,
          status: { kind: 'participating' as const, started: Date.now() }
        },
        {
          invited: Date.now(),
          playerId: ethereum.playerId,
          status: { kind: 'participating' as const, started: Date.now() }
        }
      ]
    };

    // 3. Add messages
    await ctx.db.insert('messages', {
      conversationId,
      author: binance.playerId,
      messageUuid: `${conversationId}-1`,
      text: "Hey Ethereum! How's the gas fees today?",
      worldId,
      isPrivate: true
    });

    await ctx.db.insert('messages', {
      conversationId,
      author: ethereum.playerId,
      messageUuid: `${conversationId}-2`,
      text: "They're actually quite reasonable right now! Perfect time for some DeFi action.",
      worldId,
      isPrivate: true
    });

    // 4. Update world with new private conversation
    await ctx.db.patch(worldId, {
      conversations: [...world.conversations, newConversation],
      nextId: world.nextId + 1
    });

    console.log(`Created private conversation between ${binance.name} and ${ethereum.name}`);
    return { binance: binance.name, ethereum: ethereum.name, conversationId };
  }
});

export const debugCharacterConversations = internalQuery({
  handler: async (ctx) => {
    const worldId = 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>;
    
    // 1. Get all character descriptions
    const characters = await ctx.db
      .query('playerDescriptions')
      .filter(q => q.eq(q.field('worldId'), worldId))
      .collect();
    
    console.log("1. All characters:", characters.map(c => ({
      name: c.name,
      playerId: c.playerId
    })));

    // 2. Get all conversations with participants
    const world = await ctx.db.get(worldId);
    console.log("2. Active conversations:", world?.conversations.map(c => ({
      id: c.id,
      participants: c.participants.map(p => {
        const character = characters.find(ch => ch.playerId === p.playerId);
        return {
          name: character?.name || 'Unknown',
          playerId: p.playerId
        };
      })
    })));

    // 3. Get all messages with author names
    const messages = await ctx.db
      .query('messages')
      .filter(q => q.eq(q.field('worldId'), worldId))
      .collect();

    console.log("3. Messages:", messages.map(m => ({
      conversationId: m.conversationId,
      author: characters.find(c => c.playerId === m.author)?.name || 'Unknown',
      text: m.text
    })));

    return { characters, conversations: world?.conversations, messages };
  }
});

export const clearTestConversations = internalMutation({
  handler: async (ctx) => {
    const worldId = 'm177dr6grft0v5kepyw8j8rnen75ybj1' as Id<'worlds'>;
    
    // Delete test messages
    await ctx.db
      .query('messages')
      .filter(q => q.eq(q.field('worldId'), worldId))
      .filter(q => q.or(
        q.eq(q.field('conversationId'), 'c:test1'),
        q.eq(q.field('conversationId'), 'c:54'),
        q.eq(q.field('conversationId'), 'c:55'),
        q.eq(q.field('conversationId'), 'c:2075'),
        q.eq(q.field('conversationId'), 'c:2156')
      ))
      .collect()
      .then(messages => 
        Promise.all(messages.map(msg => ctx.db.delete(msg._id)))
      );

    // Get world and remove test conversations
    const world = await ctx.db.get(worldId);
    if (!world) throw new Error("World not found");

    const cleanedConversations = world.conversations.filter(c => 
      !['c:test1', 'c:54', 'c:55', 'c:2075', 'c:2156'].includes(c.id)
    );

    await ctx.db.patch(worldId, {
      conversations: cleanedConversations
    });

    return "Cleaned up test conversations";
  }
});
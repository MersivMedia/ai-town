import { internal } from "../_generated/api";
import { v } from "convex/values";
import { ActionCtx } from "../_generated/server";

const getOpenAIKey = () => process.env.OPENAI_API_KEY;

export const EMBEDDING_DIM = 1536;

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ChatCompletionOptions {
  messages: LLMMessage[];
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
}

export const LLM_CONFIG = {
  provider: 'openai',
  model: 'gpt-4-turbo-preview',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimension: 1536
};

export async function assertApiKey() {
  if (!getOpenAIKey()) {
    throw new Error('No OpenAI API key configured. Set OPENAI_API_KEY in your environment.');
  }
}

export async function chatCompletion(options: ChatCompletionOptions) {
  const { messages, max_tokens = 1024, temperature = 0.7, stop } = options;
  
  const openaiKey = getOpenAIKey();
  if (!openaiKey) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: LLM_CONFIG.model,
        messages,
        max_tokens,
        temperature,
        stop,
        presence_penalty: 0,
        frequency_penalty: 0
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('OpenAI API error:', error);
      throw new Error(`OpenAI API error: ${JSON.stringify(error)}`);
    }
    
    const data = await response.json();
    return { content: data.choices[0].message.content };  // Changed to match expected format
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    throw error;
  }
}

export async function fetchEmbedding(text: string) {
  const embeddings = await fetchEmbeddingBatch([text]);
  return embeddings[0];
}

export async function fetchEmbeddingBatch(texts: string[]) {
  const openaiKey = getOpenAIKey();
  if (!openaiKey) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`
    };

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: LLM_CONFIG.embeddingModel,
        input: texts
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('OpenAI API error:', error);
      throw new Error(`OpenAI API error: ${JSON.stringify(error)}`);
    }
    
    const data = await response.json();
    return data.data.map((item: any) => item.embedding);
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    throw error;
  }
}

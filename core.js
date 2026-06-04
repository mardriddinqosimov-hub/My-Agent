import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { toolDefinitions, runTool } from './tools.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SOUL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SOUL.md');

export function loadSystemPrompt() {
  const soul = fs.existsSync(SOUL_PATH)
    ? fs.readFileSync(SOUL_PATH, 'utf-8')
    : 'You are a helpful personal assistant.';

  return `${soul}\n\nToday: ${new Date().toDateString()}`;
}

/**
 * Send a message and get a reply.
 * @param {string} userMessage
 * @param {Array}  history     - mutable array, modified in place
 * @param {Function} onToolCall - optional callback(toolName) called before each tool run
 */
export async function chat(userMessage, history, onToolCall = null, customTools = {}) {
  history.push({ role: 'user', content: userMessage });

  let response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: loadSystemPrompt() }, ...history],
    tools: toolDefinitions,
    tool_choice: 'auto'
  });

  while (response.choices[0].finish_reason === 'tool_calls') {
    const assistantMsg = response.choices[0].message;
    history.push(assistantMsg);

    const toolResults = [];
    for (const call of assistantMsg.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      if (onToolCall) onToolCall(call.function.name);
      const result = customTools[call.function.name]
        ? await customTools[call.function.name](args)
        : await runTool(call.function.name, args);
      toolResults.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(result)
      });
    }

    history.push(...toolResults);

    response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: loadSystemPrompt() }, ...history],
      tools: toolDefinitions,
      tool_choice: 'auto'
    });
  }

  const reply = response.choices[0].message.content;
  history.push({ role: 'assistant', content: reply });
  return reply;
}

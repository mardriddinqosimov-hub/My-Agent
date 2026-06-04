import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o';

/**
 * Stateless single-agent task executor.
 * @param {{ systemPrompt, toolDefs, toolHandlers, task, onProgress }} opts
 * @returns {Promise<string>} final text reply
 */
export async function runAgent({ systemPrompt, toolDefs = [], toolHandlers = {}, task, onProgress }) {
  const history = [{ role: 'user', content: task }];
  const callOpts = toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : {};

  let response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...history],
    ...callOpts
  });

  while (response.choices[0].finish_reason === 'tool_calls') {
    const msg = response.choices[0].message;
    history.push(msg);
    const results = [];

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      onProgress?.(`[${call.function.name}]`);
      const fn = toolHandlers[call.function.name];
      const result = fn ? await fn(args) : `Unknown tool: ${call.function.name}`;
      results.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }

    history.push(...results);
    response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      ...callOpts
    });
  }

  return response.choices[0].message.content;
}

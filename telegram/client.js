// Shared singleton — bot.js calls setBot/setOpenAI on startup
// registry.js calls getBot/getOpenAI when executing communicator tools

let _bot    = null;
let _openai = null;

export function setBot(b)    { _bot    = b; }
export function setOpenAI(o) { _openai = o; }
export function getBot()     { return _bot; }
export function getOpenAI()  { return _openai; }

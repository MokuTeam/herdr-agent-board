// The model a start asks for (#380): spawn-agent's --model, the launch request's `model`. It goes
// on the agent's command line, `--model <id>` for Claude and pi alike, after the profile's own
// arguments (the last --model is the one both take), and never into the profile's settings: a
// `/model` typed into the session would save it as the default of every later session there.
// The card keeps it (`modelWant`), so the session sheet can say the session runs on a model of its own.

/** The longest model name taken: a Bedrock ARN is about 100 characters. */
export const MODEL_MAX = 200

// An alias (opus, sonnet[1m]), a full name (claude-opus-5-5, a Vertex one with @, a Bedrock id or
// ARN with : and /), pi's provider/id: one word that starts with a letter or digit, so it is never
// read as an option, and nothing a shell or herdr would take apart.
const MODEL = /^[A-Za-z0-9][\w.:/@+[\]-]*$/

/** What is wrong with a model name: 'long', 'chars', or null when it can go on a command line. */
export function modelProblem(value: string): 'long' | 'chars' | null {
  if (value.length > MODEL_MAX) return 'long'
  return MODEL.test(value) ? null : 'chars'
}

/** The arguments that start an agent on `model`: none for none. */
export const modelArgs = (model: string | null | undefined): string[] => (model ? ['--model', model] : [])

/** Claude Code's model aliases, the newest of each family: the new-session window suggests them. */
export const CLAUDE_MODEL_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku']

// Nova Developer Mode backend.
// "/update [kaam]" -> AI ek CSS/JS patch banata hai, jo Netlify Blobs me save hota hai
// aur site load hote hi har visitor ke liye apply ho jata hai (bina redeploy ke).
import { Hono } from 'hono'
import { getStore } from '@netlify/blobs'
import Anthropic from '@anthropic-ai/sdk'
import { timingSafeEqual, createHash } from 'node:crypto'

const app = new Hono()
const anthropic = new Anthropic()
const MODEL = 'claude-sonnet-5-5'
const MAX_PATCHES = 50

const store = () => getStore({ name: 'nova-dev', consistency: 'strong' })
const loadPatches = async () => (await store().get('patches', { type: 'json' })) || []
const savePatches = (p) => store().setJSON('patches', p)

function isDev(c) {
  const given = c.req.header('x-dev-key') || ''
  const real = process.env.NOVA_DEV_KEY || ''
  if (!real || !given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(real).digest()
  return timingSafeEqual(a, b)
}

// Public: patches jo site par apply honi hain
app.get('/api/patches', async (c) => {
  const patches = await loadPatches()
  return c.json(patches.map(({ id, css, js }) => ({ id, css, js })), 200, { 'cache-control': 'no-store' })
})

app.post('/api/dev/verify', (c) => (isDev(c) ? c.json({ ok: true }) : c.json({ ok: false }, 401)))

app.get('/api/dev/list', async (c) => {
  if (!isDev(c)) return c.json({ error: 'Galat developer key' }, 401)
  const patches = await loadPatches()
  return c.json(patches.map(({ id, task, summary, time }) => ({ id, task, summary, time })))
})

app.post('/api/dev/undo', async (c) => {
  if (!isDev(c)) return c.json({ error: 'Galat developer key' }, 401)
  const patches = await loadPatches()
  const removed = patches.pop()
  await savePatches(patches)
  return c.json({ removed: removed ? { task: removed.task, summary: removed.summary } : null, left: patches.length })
})

app.post('/api/dev/reset', async (c) => {
  if (!isDev(c)) return c.json({ error: 'Galat developer key' }, 401)
  await savePatches([])
  return c.json({ ok: true })
})

const SYSTEM = `You are the developer agent for "Nova", a single-page AI chatbot website (Tailwind CDN, Poppins font, vanilla JS).
The site owner gives you a task (often in Hindi/Hinglish). You implement it as a PATCH that is applied at runtime on top of the original page:
- "css": CSS text injected in a <style> tag at the end of <head>.
- "js": JavaScript executed once after the page has loaded (DOM is ready, all page globals such as chatBox, addMsg, ask, history, SYSTEM_PROMPT, newChat exist). It may create/modify DOM elements, add event listeners, wrap global functions, etc.
Rules:
- Return ONLY a JSON object: {"css": string, "js": string, "summary": string}. No markdown fences.
- "summary": 1-2 short lines in the same language the owner used, describing what changed.
- Previous patches are already applied; build on them, don't repeat them.
- Never break existing chat, history (localStorage key "nova_chats") or the send flow. Wrap risky JS in try/catch.
- Never send data to third-party servers, never read or expose secrets, never add tracking.
- Keep the existing dark glass design language unless the task asks to change it.
- If the task is impossible with a CSS/JS patch, return empty css/js and explain in summary.`

app.post('/api/dev/update', async (c) => {
  if (!isDev(c)) return c.json({ error: 'Galat developer key' }, 401)
  const { task } = await c.req.json().catch(() => ({}))
  if (!task || typeof task !== 'string') return c.json({ error: 'Kaam likho: /update [kaam]' }, 400)

  const origin = new URL(c.req.url).origin
  const html = await fetch(origin + '/').then((r) => r.text()).catch(() => '')
  const patches = await loadPatches()
  const prev = patches.map((p, i) => `#${i + 1} task: ${p.task}\nCSS:\n${p.css}\nJS:\n${p.js}`).join('\n\n') || '(none)'

  // AI ko time lagta hai, isliye response turant shuru karke spaces bhejte rehte hain (JSON.parse leading whitespace ignore karta hai)
  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => controller.enqueue(enc.encode(' ')), 5000)
      controller.enqueue(enc.encode(' '))
      let out
      try {
        const msg = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 8000,
          system: SYSTEM,
          messages: [{
            role: 'user',
            content: `ORIGINAL PAGE HTML:\n${html.slice(0, 60000)}\n\nPREVIOUS PATCHES:\n${prev.slice(0, 40000)}\n\nTASK: ${task}`,
          }],
        })
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
        const patch = {
          id: Date.now().toString(),
          task,
          css: String(json.css || ''),
          js: String(json.js || ''),
          summary: String(json.summary || 'Update ho gaya.'),
          time: Date.now(),
        }
        if (patch.css || patch.js) {
          patches.push(patch)
          await savePatches(patches.slice(-MAX_PATCHES))
        }
        out = { ok: true, applied: !!(patch.css || patch.js), summary: patch.summary, id: patch.id, css: patch.css, js: patch.js }
      } catch (e) {
        console.error('update failed', e)
        out = { ok: false, error: 'Update fail ho gaya: ' + String(e?.message || e).slice(0, 150) }
      }
      clearInterval(ping)
      controller.enqueue(enc.encode(JSON.stringify(out)))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
})

export default app

export const config = { path: '/api/*' }

const URL = "https://openrouter.ai/api/v1/chat/completions";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Statuses that describe one model's answer rather than the account, so the next
// model in the rotation is worth trying. Anything outside this set and below 500
// throws, because it would fail identically on every model. 401 and 402 are
// deliberately absent: a bad key or an empty balance is the account, not the
// model, and retrying those just spends the run's budget to fail again.
const RETRYABLE = [400, 403, 404, 429];

const NUDGE = {
  role: "system",
  content:
    "Your last reply was discarded: it was not the required JSON object. Some of what you sent was working notes, or a moderation verdict, or it stopped before the object was finished. Send the single JSON object only, starting with { and ending with }, and keep the summary short.",
};

// complete calls OpenRouter until accept() turns the reply into something
// usable, retrying on rate limits, upstream failures, truncated answers, and
// replies that are not a review at all. Attempt i goes to models[i], wrapping
// around, so a retry is also how we get off a model that is down, gone from
// the free list, or thinking out loud.
export async function complete({ apiKey, models, messages, accept = (t) => t, attempts = 5, backoff = 15000, log = console.log }) {
  let last = "no attempt made";
  let nudge = false;
  for (let i = 0; i < attempts; i++) {
    if (i) {
      const wait = backoff * i;
      log(`openrouter attempt ${i} failed (${last}), retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
    const model = models[i % models.length];
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: nudge ? [...messages, NUDGE] : messages,
        temperature: 0.2,
        max_tokens: 8000,
        // Keep a reasoning model's trace out of the content we publish.
        reasoning: { exclude: true },
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      // Every status below is something the next model can answer differently.
      // 400 and 404 are what a model that left the free list answers, or one
      // that cannot take this prompt. 429 is a rate limit and clears.
      //
      // 403 belongs here too, and its absence killed a real run. OpenRouter
      // answers 403 when a model is gated to agentic harnesses, naming the
      // harness it wants. That is a fact about one model, not about the key, so
      // it must not throw: throwing on it abandoned the review entirely, after
      // three earlier attempts had already failed for unrelated reasons, and the
      // log ended on a 403 that read like a permissions problem. Auth and credit
      // errors still throw, since those fail the same way on every model.
      if (!RETRYABLE.includes(res.status) && res.status < 500) throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
      last = `${model} ${res.status}: ${body.slice(0, 300)}`;
      continue;
    }
    const data = JSON.parse(body);
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    const picked = data.model ?? model;
    if (typeof text !== "string" || !text.trim()) {
      last = `${picked} returned an empty completion`;
      continue;
    }
    if (choice.finish_reason === "length") {
      last = `${picked} ran out of tokens before finishing`;
      nudge = true;
      continue;
    }
    const value = accept(text);
    if (value != null) return { value, text, model: picked };
    last = `${picked} did not reply with a review (${text.length} chars)`;
    nudge = true;
  }
  throw new Error(`OpenRouter gave up after ${attempts} attempts: ${last}`);
}

# Why I Built PETO

If you're using Claude Code, Codex, or Cursor, you're probably paying for maximum reasoning on requests that don't need it.

Not sometimes. Every request. "Try again." "What does this function do." "Summarize that." All of them hitting the same top-tier reasoning budget as your most complex architecture review.

You probably don't know which ones are wasteful. And you probably have no way to measure it.

I didn't either — until I spent three months trying to fix it.

---

## The obvious solution didn't work

My first instinct was a category table. Translation = low effort. Debugging = high. Architecture = maximum.

It fell apart in a day. The same translation could be quick and cheap, or it could be tone-sensitive legal copy where getting it wrong costs money. The category told me nothing. The context was everything.

So I asked a different question: what if a cheap model just reads each request and decides, the same way a smart assistant would?

I built that. One rule it could never break: don't touch the request. Don't summarize, tag, or rewrite. Just pick the effort level and pass the original through unchanged. The person asking shouldn't know the dispatcher exists. Neither should the model answering it.

---

## Costs dropped. Answers seemed fine. But "seemed fine" is not a methodology.

So I built what I didn't want to build: a full verification harness. Run the same requests twice — once at the routed effort, once at maximum. Compare token costs. Judge whether the cheaper answer actually satisfied the request. Only count savings when both sides of the comparison completed cleanly.

Three things surprised me along the way.

Measuring honestly makes your claim smaller. Some requests can't be tested fairly offline — anything that needs live files, ongoing sessions, or local state. I had to exclude them. The honest scope is narrower than I originally wanted. But narrower and true beats broader and wrong.

What counts as "good enough" is personal. External benchmarks told me nothing useful. The only signal that matters is whether your specific user, in their specific context, accepted the output. That can't be downloaded. It has to be collected from your own traffic. The longer you run PETO, the more it learns about your patterns — not some average user's.

The data ends up being more valuable than the routing. The routing algorithm is something anyone can copy. The acceptance signals you accumulate over time — what "good enough" actually means for your users — nobody can replicate that without your traffic.

---

## What it proved

After all that: roughly 17.6% real token savings on real traffic, on requests where reasoning depth was the actual variable, with quality verified by an automated judge on matched pairs. Not estimated from a benchmark. Measured by running the same requests both ways.

It doesn't work on everything. The documentation says so plainly.

If you're paying real API bills and you've wondered whether all that reasoning was actually necessary — the repo is open, MIT licensed, and you can run the verification on your own logs.

**[github.com/your-repo]** — and if the measurement methodology interests you more than the savings number, that's probably a sign you should try it.

---

## One last thing

The name came from a conversation. Personalized Effort and Tokenomics Optimization. The acronym stuck.

Personalized is the part I keep coming back to. Generic routing optimizes for the average request. What I'm trying to do is find the cheapest answer that *you* will actually accept — not what a leaderboard predicts, not what a category table suggests. You, with your specific users, your specific quality bar, your specific traffic.

Most AI cost tools treat every user the same. That's the assumption I'm trying to break.

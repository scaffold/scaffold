---
theme: default
title: Scaffold — Foundation for the distributed web
info: |
  Scaffold is a browser-native protocol that turns every
  user's device into infrastructure. Contracts are WebAssembly,
  transport is WebRTC, and results are verified economically
  through collateral rather than by a central authority.
highlighter: shiki
lineNumbers: false
drawings:
  persist: false
transition: none
mdc: true
layout: cover
---

# The foundation<br>for the <em>distributed</em><br>web.

<p class="sub">
<br />
Scaffold is a browser-native protocol that turns your users into infrastructure.
</p>

---
layout: section
num: "01"
kicker: "The problem"
---

## The cloud is a not-so-necessary evil.

<p class="sub" style="margin-top: 24px; max-width: 60ch;">
Cloud costs are now the #2 expense at midsize IT companies — behind only payroll. On average, organizations spend 10% of revenues on cloud services. AWS's revenue last year was >$110B. <sup>[<a href="https://www.cloudzero.com/blog/cloud-computing-statistics/" style="text-decoration: none; border-bottom: none;" target="_blank">1</a>]</sup>
</p>

<p class="sub" style="margin-top: 20px; max-width: 60ch; color: var(--fg-3);">
Scaffold is a way to build products that don't run on the conventional cloud.
</p>

---
layout: statement
kicker: "The thesis"
---

# The user<br>is the <em>cloud.</em>

<p class="sub" style="margin-top: 32px; font-size: 22px; max-width: 54ch;">
Every modern browser runs WebAssembly, speaks WebRTC, and has more than enough local compute for what it needs. Scaffold is the protocol that bridges compute, consensus, and trust.
</p>

---
layout: split
num: "02"
kicker: "What Scaffold is"
ratio: "5fr 6fr"
---

::left::

<h2>A protocol for <em>browser-native</em> compute.</h2>

<p class="sub" style="margin-top: 24px">
A developer publishes a WebAssembly contract, addressed by its hash. An application calls <code>fetch('scf://hash/...')</code>. The call is routed over WebRTC to any peer on the network that has the contract, which executes it and returns the result with collateral staked on its correctness. Any other peer can re-run the same contract later; if the result differs, the collateral is slashed and paid to whoever caught the error.
</p>

::right::

<div class="spec" style="border-top: 1px solid var(--fg); padding-top: 14px; margin-top: 60px">
  <div class="row"><span>API</span><b><code>fetch()</code></b></div>
  <div class="row"><span>Contract runtime</span><b>WebAssembly</b></div>
  <div class="row"><span>Transport</span><b>WebRTC + WebSockets</b></div>
  <div class="row"><span>Data structure</span><b>A tree of immutable blocks</b></div>
  <div class="row"><span>Proof of work</span><b>Verified computation</b></div>
  <div class="row"><span>Trust vehicle</span><b>Collateral</b></div>
</div>

---
layout: split
num: "03"
kicker: "Developer experience"
ratio: "5fr 7fr"
---

::left::

<h2>Your first app is <em>one import</em> and a dozen lines of code.</h2>

<p class="sub" style="margin-top: 24px">
Scaffold is wrapped inside a single method: <code>fetch()</code>. Existing projects can integrate Scaffold incrementally, usually starting with a single call to a single contract.
</p>

<p style="margin-top: 24px; font-family: var(--font-mono); font-size: 12px; color: var(--fg-3); letter-spacing: 0.08em;">
npm install @scaffold/core
</p>

::right::

<CodeWindow title="main.ts" meta="greeter contract">

```ts
import { Scaffold, browserConfig } from '@scaffold/core';

// Connect to the Scaffold network.
const scaffold = new Scaffold(browserConfig);

// Any WASM contract, addressed by its hash.
const greeter = '0xdda8ecfd22ea…';

// The request is routed to a peer that has the contract;
// the peer runs it and returns the result with collateral.
const hello = await scaffold.fetch({
  contractHash: greeter,
  params: 'World',
});

console.log(hello.text()); // → "Hello World!"
```

</CodeWindow>

---
layout: statement
kicker: "The core insight"
---

# You can <em>trust</em><br>collateral.

<p class="sub" style="margin-top: 32px; font-size: 20px; max-width: 58ch;">
A peer that stakes one dollar to answer a one-cent query has put one hundred times the query's value at risk. The answer is not trusted because a quorum voted on it; it is trusted because the peer has committed real economic weight to its correctness. Correctness is priced continuously, and the incentive to catch bad responses is built directly into the protocol.
</p>

---
num: "04"
kicker: "Why now"
---

## The primitives Scaffold depends on<br>only recently became <em>available.</em>

<div class="why-grid" style="margin-top: 24px">
  <div>
    <span class="idx">01 · Transport</span>
    <h3>WebRTC</h3>
    <p>Peer-to-peer connections in the browser became stable across every major vendor in the last three years. Before that, every P2P application had to fall back to a relay.</p>
  </div>
  <div>
    <span class="idx">02 · Execution</span>
    <h3>WebAssembly</h3>
    <p>Near-native speed and deterministic execution across browsers, Deno, and Node. The same binary produces the same output in every runtime, making efficient verification possible.</p>
  </div>
  <div>
    <span class="idx">03 · Parallelism</span>
    <h3>Web Workers</h3>
    <p>Every tab has parallel compute available for free. Contracts run without blocking the main thread, which is what makes them usable inside real applications.</p>
  </div>
  <div>
    <span class="idx">04 · Portability</span>
    <h3>WASI (planned)</h3>
    <p>The list of things that run in the browser grows by the day. Scaffold leverages WASI to run almost anything with minimal modification. Python, JavaScript, Go, and Ruby will all be able to run upon Scaffold.</p>
  </div>
</div>

<p class="sub" style="margin-top: 16px; max-width: 64ch; font-size: 14px; color: var(--fg-3)">
Scaffold is the first browser-based protocol taking advantage of these.
</p>

<style scoped>
.why-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
}
.why-grid > div {
  background: var(--bg);
  padding: 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.why-grid .idx { font-family: var(--font-mono); font-size: 10px; color: var(--accent); letter-spacing: 0.1em; }
.why-grid h3 { margin: 2px 0 4px !important; font-size: 17px !important; }
.why-grid p { color: var(--fg-2); font-size: 12.5px; line-height: 1.5; margin: 0; }
</style>

---
layout: section
num: "05"
kicker: "The wedge"
---

## Zero-infrastructure applications.

<p class="sub" style="margin-top: 24px; max-width: 64ch;">
A Scaffold application has no servers to rent, no CDN to configure, no database to operate, and no scaling plan to worry about. Every user is a host, and the application's capacity grows in proportion to its usage. For an indie developer, this means shipping a viral app without paying a hosting bill. For a startup, it means infrastructure cost starting at zero. For a mature product, it means there's no infrastructure to go down.
</p>

<p class="sub" style="margin-top: 18px; max-width: 64ch; color: var(--fg-3); font-size: 15px;">
Ship your app by calling `fetch()`. Scaffold takes care of the rest.
</p>

---
num: "06"
kicker: "What this enables"
---

## Three kinds of applications<br>change shape under Scaffold.

<div class="hair-grid cols-3" style="margin-top: 28px">
  <div>
    <span class="idx">01 · Social</span>
    <h3>No origin to silence.</h3>
    <p>A signed post resolves to the same content from any peer on the network; the author's identity is the address. 100% distributed, 100% uptime, and 100% controlled by the user.</p>
  </div>
  <div>
    <span class="idx">02 · Multiplayer state</span>
    <h3>Matches without a server.</h3>
    <p>Deterministic WebAssembly combined with Scaffold's quick consensus allows every player's browser to agree on shared state — a game, a document, a whiteboard — without a central authority hosting the session. The players are the database.</p>
  </div>
  <div>
    <span class="idx">03 · Distributed uber</span>
    <h3>Call your ride.</h3>
    <p>A mobile app + a set of Scaffold contracts handle drivers bidding, picking you up, verifying your drop-off, and distributing payment to the driver.</p>
  </div>
</div>

---
num: "07"
kicker: "Roadmap"
---

## Two milestones.

<div class="timeline">
  <div class="phase done">
    <span class="mark">April 2026</span>
    <h3>Today.</h3>
    <p>Protocol specification, reference implementation, 819 passing tests, and a working browser demo.</p>
  </div>
  <div class="phase active">
    <span class="mark">July 31, 2026</span>
    <h3>Testnet launch.</h3>
    <p>Signed releases, seeded peers on the public network, <code>@scaffold/core</code> published to npm, and the explorer opened to the public. Developers can publish contracts and call them from any browser.</p>
  </div>
  <div class="phase">
    <span class="mark">December 31, 2026</span>
    <h3>Mainnet launch.</h3>
    <p>Secure, solid, and ready to build production applications upon. Collateral enforcement and dispute resolution are running in production.</p>
  </div>
  <div class="phase">
    <span class="mark">2027</span>
    <h3>Ecosystem.</h3>
    <p>First-party reference applications — social, game state, query contracts — followed by third-party development on top of the protocol.</p>
  </div>
</div>

<style>
.timeline {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  margin-top: 28px;
  border-top: 1px solid var(--fg);
}
.timeline .phase {
  padding: 22px 18px 20px;
  border-right: 1px solid var(--border);
  position: relative;
  min-height: 220px;
}
.timeline .phase:last-child { border-right: none; }
.timeline .phase .mark {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.timeline .phase.active .mark,
.timeline .phase.done .mark { color: var(--accent); }
.timeline .phase h3 { margin: 10px 0 8px !important; font-size: 18px !important; }
.timeline .phase p { font-size: 13px; color: var(--fg-2); line-height: 1.55; max-width: 36ch; }
.timeline .phase::before {
  content: '';
  position: absolute;
  top: -6px; left: 0;
  width: 10px; height: 10px;
  background: var(--bg);
  border: 1px solid var(--fg);
  border-radius: 50%;
}
.timeline .phase.done::before,
.timeline .phase.active::before { background: var(--accent); border-color: var(--accent); }
</style>

---
num: "08"
kicker: "Economics"
---

## A protocol, not a company.

<p class="sub" style="margin-top: 24px; max-width: 62ch;">
Scaffold is an open protocol. There is no corporate entity between the user and the network. Usage of the protocol is priced in a native token: peers that host contracts earn it, verifiers that catch wrong answers earn it, and applications that deploy and call contracts spend it. The token also denominates the collateral staked against each response.
</p>

<p class="sub" style="margin-top: 18px; max-width: 62ch;">
The initial distribution is split between early protocol participants and investors who fund the launch. As usage grows, the token's utility grows, which draws more peers to the network, which increases capacity.
</p>

---
layout: statement
kicker: "The bet"
---

# <em>Scaffold</em> is betting<br>on two things.

<div class="bets" style="margin-top: 32px">
  <div>
    <b>The browser is the future.</b>
    <p>It is now a compute platform. It has the runtime, the transport, and the parallelism to host the infrastructure the web needs.</p>
  </div>
  <div>
    <b>Distributed systems are the future.</b>
    <p>Crypto has been a solution to the wrong problem. Users don't want another currency. They want compute.</p>
  </div>
</div>

<p class="sub" style="margin-top: 28px; max-width: 56ch; font-size: 16px; color: var(--fg-3);">
Scaffold is the bridge
</p>

<style scoped>
.bets { display: flex; flex-direction: column; gap: 14px; max-width: 72ch; }
.bets > div { border-left: 2px solid var(--accent); padding: 4px 20px 4px 18px; }
.bets b { display: block; color: var(--fg); font-size: 18px; font-weight: 500; font-family: var(--font-display); letter-spacing: -0.02em; margin-bottom: 4px; }
.bets p { color: var(--fg-2); font-size: 14px; line-height: 1.5; margin: 0; max-width: 64ch; }
</style>
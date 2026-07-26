#!/usr/bin/env python3
"""Headless CDP smoke for Dispatches / Broadcast / Star Map Close."""
import asyncio, base64, json, pathlib, sys, urllib.request
sys.path.insert(0, "/home/ubuntu/.local/lib/python3.12/site-packages")
import websockets

ART = pathlib.Path("/opt/cursor/artifacts")
ART.mkdir(parents=True, exist_ok=True)

async def main():
  # Prefer creating a target via Browser domain after connecting to browser WS.
  ver = json.loads(urllib.request.urlopen("http://127.0.0.1:9222/json/version").read())
  browser_ws = ver["webSocketDebuggerUrl"]
  idn = 0

  async with websockets.connect(browser_ws, max_size=40_000_000) as bws:
    async def bcall(method, params=None):
      nonlocal idn
      idn += 1
      msg = {"id": idn, "method": method}
      if params: msg["params"] = params
      await bws.send(json.dumps(msg))
      while True:
        raw = json.loads(await bws.recv())
        if raw.get("id") == idn:
          if "error" in raw: raise RuntimeError(raw["error"])
          return raw["result"]

    tgt = await bcall("Target.createTarget", {"url": "http://localhost:8000/"})
    session = await bcall("Target.attachToTarget", {"targetId": tgt["targetId"], "flatten": True})
    session_id = session["sessionId"]

    async def call(method, params=None):
      nonlocal idn
      idn += 1
      msg = {"id": idn, "method": method, "sessionId": session_id}
      if params: msg["params"] = params
      await bws.send(json.dumps(msg))
      while True:
        raw = json.loads(await bws.recv())
        if raw.get("id") == idn:
          if "error" in raw: raise RuntimeError(raw["error"])
          return raw.get("result", {})

    await call("Page.enable")
    await call("Runtime.enable")
    await call("Emulation.setDeviceMetricsOverride", {
      "width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True,
    })
    # Wait until Game.state exists (tutorial/boot may delay it)
    for _ in range(80):
      r = await call("Runtime.evaluate", {
        "expression": "!!(window.Game && window.Game.state && window.Story && window.UI && window.StarMap)",
        "returnByValue": True,
      })
      if r.get("result", {}).get("value"):
        break
      await asyncio.sleep(0.25)
    else:
      raise RuntimeError("Game boot timed out")
    await asyncio.sleep(0.5)

    async def js(expr):
      r = await call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
      if r.get("exceptionDetails"):
        raise RuntimeError(r["exceptionDetails"])
      return r.get("result", {}).get("value")

    async def shot(name):
      data = await call("Page.captureScreenshot", {"format": "png"})
      (ART / name).write_bytes(base64.b64decode(data["data"]))
      print("shot", name)

    # Dismiss blockers (tutorial / incidents / WYWA)
    for _ in range(8):
      await js("""
(() => {
  for (const sel of ['#wywa-close','#inc-close','#tut-skip','#tut-close','#tut-next']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) el.click();
  }
  document.querySelectorAll('.modal-backdrop:not(.hidden) button').forEach(b => {
    if (/continue|collect|skip|close|dismiss|got it|next/i.test(b.textContent||'')) b.click();
  });
  return document.querySelectorAll('.modal-backdrop:not(.hidden)').length;
})()""")
      await asyncio.sleep(0.2)

    # Seed dispatch if empty
    seeded = await js("""
(() => {
  if (!Game.state) return 'no-state';
  Story.s(); // ensure story shape
  if (Story.conversations().length) return 'existing:' + Story.conversations().length;
  const id = 'test_arc';
  const st = Game.state;
  const story = Story.s();
  story.ephemeral = story.ephemeral || {};
  story.ephemeral[id] = {
    id, kind: 'job', from: 'Test Contact', portrait: 1,
    steps: [{ key: 'open', text: 'Hello baron — line A.\\n\\nLine B for history.',
      choices: [
        { label: 'Accept', reply: 'Sure.', ack: 'Good.', end: true },
        { label: 'Decline', reply: 'No.', ack: 'Fine.', end: true }
      ],
      replies: [{ label: 'Who are you?', reply: 'Name?', ack: 'A friend.' }]
    }],
    outro: 'Done.'
  };
  story.prog[id] = { step: 0, base: Story.snap(st), status: 'active', accepted: true };
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    story.inbox.push({ arc: id, type: i%2?'out':'in', from: i%2?'You':'Test Contact',
      portrait: 1, text: 'History message #' + i, ts: now - (9-i)*120000, read: true });
  }
  Story._postIn(story.ephemeral[id], story.ephemeral[id].steps[0]);
  return 'seeded:' + Story.conversations().length;
})()""")
    print("SEED", seeded)

    open_res = await js("""
(() => {
  UI.showPage('comms');
  UI.showCommsTab('dispatches');
  const row = document.querySelector('.disp-row');
  if (!row) return { ok:false, reason:'no row' };
  row.click();
  const layout = document.getElementById('dispatch-body');
  const sidebar = layout.querySelector('.disp-sidebar');
  const thread = layout.querySelector('.dispatch-thread');
  return {
    ok: true,
    threadOpen: layout.classList.contains('thread-open'),
    sidebarDisplay: getComputedStyle(sidebar).display,
    hasThread: !!thread,
    hasBack: !!layout.querySelector('[data-back]'),
    hasActions: !!layout.querySelector('.disp-actions'),
    nearBottom: thread ? (thread.scrollHeight - thread.scrollTop - thread.clientHeight) < 40 : false,
    scrollH: thread && thread.scrollHeight,
    clientH: thread && thread.clientHeight,
  };
})()""")
    print("DISPATCH_OPEN", json.dumps(open_res, indent=2))
    await shot("dispatches-mobile-open.png")
    assert open_res["ok"] and open_res["threadOpen"], open_res
    assert open_res["sidebarDisplay"] == "none", open_res
    assert open_res["hasThread"] and open_res["hasBack"] and open_res["hasActions"], open_res

    back_res = await js("""
(() => {
  document.querySelector('[data-back]').click();
  const layout = document.getElementById('dispatch-body');
  return {
    threadOpen: layout.classList.contains('thread-open'),
    rows: document.querySelectorAll('.disp-row').length,
    sidebarDisplay: getComputedStyle(layout.querySelector('.disp-sidebar')).display,
  };
})()""")
    print("DISPATCH_BACK", json.dumps(back_res, indent=2))
    await shot("dispatches-mobile-list.png")
    assert back_res["threadOpen"] is False and back_res["rows"] >= 1, back_res
    assert back_res["sidebarDisplay"] != "none", back_res

    await call("Emulation.setDeviceMetricsOverride", {
      "width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": False,
    })
    bc = await js("""
(() => {
  UI.showPage('comms'); UI.showCommsTab('broadcast');
  Broadcast.rotateTV();
  const img = document.getElementById('bc-frame');
  const scr = document.getElementById('broadcast-screen');
  const r = scr.getBoundingClientRect();
  return {
    objectFit: getComputedStyle(img).objectFit,
    maxHeight: getComputedStyle(scr).maxHeight,
    height: Math.round(r.height),
    width: Math.round(r.width),
  };
})()""")
    print("BROADCAST", json.dumps(bc, indent=2))
    await shot("broadcast-desktop.png")
    assert bc["objectFit"] == "contain", bc
    assert bc["height"] >= 160, bc  # taller than old 132px cap

    sm = await js("""
(() => {
  StarMap.openGalaxy();
  const unlocked = Game.state.unlockedSystems || [];
  let sysId = unlocked[0] || 'navos';
  try {
    const ids = Object.keys(Galaxy.systems || {});
    if (ids.length) sysId = ids.find(id => id !== Game.state.currentSystem) || ids[0];
  } catch (e) {}
  StarMap.openSystem(sysId);
  const inSystem = !document.getElementById('system-view').classList.contains('hidden');
  document.getElementById('sm-close').click();
  const after1 = {
    overlayHidden: document.getElementById('starmap-overlay').classList.contains('hidden'),
    galaxyHidden: document.getElementById('galaxy-view').classList.contains('hidden'),
    systemHidden: document.getElementById('system-view').classList.contains('hidden'),
    open: !!StarMap.open,
  };
  document.getElementById('sm-close').click();
  const after2 = {
    overlayHidden: document.getElementById('starmap-overlay').classList.contains('hidden'),
    open: !!StarMap.open,
  };
  return { sysId, inSystem, after1, after2 };
})()""")
    print("STARMAP", json.dumps(sm, indent=2))
    # Capture galaxy-after-close
    await js("""
(() => {
  StarMap.openGalaxy();
  const id = (Game.state.unlockedSystems||[])[0] || 'navos';
  StarMap.openSystem(id);
  document.getElementById('sm-close').click();
})()""")
    await asyncio.sleep(0.2)
    await shot("starmap-after-system-close.png")
    assert sm["inSystem"], sm
    assert sm["after1"]["open"] and not sm["after1"]["overlayHidden"], sm
    assert (not sm["after1"]["galaxyHidden"]) and sm["after1"]["systemHidden"], sm
    assert sm["after2"]["overlayHidden"] and not sm["after2"]["open"], sm

    print("ALL_UI_CHECKS_PASSED")

asyncio.run(main())

/* Headless check: planet sprites use a live DOM <img> (so GIFs can animate),
   and survey-modal stacks above the star map. No browser — parses source. */
const fs = require("fs");
const assert = (c, m) => { if (!c) throw new Error(m); };

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("css/style.css", "utf8");
const js = fs.readFileSync("js/planetview.js", "utf8");

assert(/id="pm-sprite"/.test(html), "index.html must include #pm-sprite");
assert(/#survey-modal\s*\{\s*z-index:\s*80/.test(css) || /#planet-modal,\s*\n#survey-modal\s*\{\s*z-index:\s*80/.test(css),
  "survey-modal must be z-index 80");
assert(/\.starmap\s*\{[^}]*z-index:\s*70/.test(css), "starmap must stay z-index 70");
assert(/_showSprite/.test(js) && /_hideSprite/.test(js), "planetview must drive a DOM sprite");
assert(!/ctx\.drawImage\(img/.test(js) || !/_drawSprite/.test(js),
  "planet disc must not rely on canvas drawImage for uploaded sprites");
assert(/animated GIFs actually play|GIF animation/.test(js), "comment should document why DOM img is used");

console.log("check_planet_sprite_gif: ok");

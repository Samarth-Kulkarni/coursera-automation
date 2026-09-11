/**
 * popup-learner.js — Self-Learning Pop-up & Redirect Handler
 * -----------------------------------------------------------
 * Generic interruption engine for Coursera automation.
 *
 * Instead of hard-coding CSS selectors for every Coursera popup type,
 * this module:
 *   1. Detects ANY overlay/modal using universal DOM signals
 *   2. Detects full-page redirects (surveys, onboarding, career pages)
 *   3. Scores candidate buttons to pick the safest dismissal action
 *   4. Persists a "memory" file so the bot learns from each encounter
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Memory file path ────────────────────────────────────────────────────────
const MEMORY_PATH = path.join(__dirname, 'popup-memory.json');

// ─── URL patterns ────────────────────────────────────────────────────────────
// URLs that are expected during normal course navigation.
const COURSE_URL_PATTERNS = [
  /\/learn\/[^/]+\/lecture\//i,
  /\/learn\/[^/]+\/item\//i,
  /\/learn\/[^/]+\/home\//i,
  /\/learn\/[^/]+\/supplement\//i,
  /\/learn\/[^/]+\/ungradedWidget\//i,
  /\/learn\/[^/]+\/discussionPrompt\//i,
  /\/learn\/[^/]+\/peer\//i,
  /\/learn\/[^/]+\/programming\//i,
  /\/learn\/[^/]+\/gradedLti\//i,
  /\/learn\/[^/]+\/quiz\//i,       // quiz pages — handled separately by the main script
  /\/learn\/[^/]+\/exam\//i,       // exam pages — handled separately
  /\/learn\/[^/]+\/assignment\//i,
];

// URLs that are definitely NOT part of the lecture flow.
const REDIRECT_URL_PATTERNS = [
  /\/career-academy\//i,
  /\/career-goals\//i,
  /\/onboarding\//i,
  /\/survey\//i,
  /\/programs\//i,
  /\/my-learning/i,
  /\/professional-certificates\//i,
  /\/degrees\//i,
  /\/browse\//i,
  /\/recommendations\//i,
  /\/skills\//i,
  /\/goals\//i,
  /\/profile-completion/i,
];

// ─── Button scoring ──────────────────────────────────────────────────────────
// Each rule: [pattern (regex on button text), score, reason]
const BUTTON_SCORE_RULES = [
  // Highest priority: resume lecture
  [/continue\s+to\s+video/i, 100, 'resume-video'],
  [/resume\s+video/i, 100, 'resume-video'],
  [/back\s+to\s+(course|lecture|video)/i, 95, 'back-to-course'],
  [/return\s+to\s+(course|lecture)/i, 95, 'back-to-course'],

  // Strong dismissal
  [/^skip$/i, 80, 'skip'],
  [/skip\s+for\s+now/i, 80, 'skip'],
  [/^got\s+it$/i, 80, 'dismiss'],
  [/^dismiss$/i, 80, 'dismiss'],
  [/^ok$/i, 80, 'dismiss'],
  [/^okay$/i, 80, 'dismiss'],
  [/^close$/i, 80, 'dismiss'],

  // Escape intent — common on survey/redirect pages
  [/^exit$/i, 75, 'exit'],
  [/^leave$/i, 75, 'exit'],
  [/not\s+now/i, 75, 'exit'],
  [/no\s*,?\s*thanks/i, 75, 'exit'],
  [/maybe\s+later/i, 75, 'exit'],
  [/remind\s+me\s+later/i, 70, 'exit'],

  // Consent / honor code
  [/^i?\s*accept$/i, 70, 'accept'],
  [/^i?\s*agree$/i, 70, 'accept'],
  [/i\s+understand/i, 70, 'accept'],

  // Progression
  [/^start$/i, 60, 'start'],
  [/^begin$/i, 60, 'start'],
  [/^continue$/i, 60, 'continue'],
  [/^resume$/i, 60, 'continue'],
  [/^next$/i, 55, 'next'],

  // In-video quiz submit
  [/^submit$/i, 40, 'submit'],
  [/check\s+answer/i, 40, 'submit'],

  // Soft dismissal
  [/^cancel$/i, 30, 'cancel'],

  // Survey-only (low score — only used as last resort)
  [/save\s+(&|and)\s+continue/i, 20, 'survey-save'],

  // ── NEGATIVE scores: never click ──
  [/upgrade/i, -50, 'upsell'],
  [/subscribe/i, -50, 'upsell'],
  [/premium/i, -50, 'upsell'],
  [/coursera\s+plus/i, -50, 'upsell'],
  [/buy/i, -50, 'upsell'],
  [/purchase/i, -50, 'upsell'],
  [/enroll\s+now/i, -30, 'upsell'],

  [/delete/i, -100, 'danger'],
  [/remove/i, -100, 'danger'],
  [/sign\s+out/i, -100, 'danger'],
  [/log\s*out/i, -100, 'danger'],
  [/deactivate/i, -100, 'danger'],
];

// Minimum score for a button to be auto-clicked
const SAFE_SCORE_THRESHOLD = 25;

// ─── Memory management ──────────────────────────────────────────────────────

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      const raw = fs.readFileSync(MEMORY_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.log('  [popup-learner] Warning: Could not load memory file, starting fresh.');
  }
  return { fingerprints: {} };
}

function saveMemory(memory) {
  try {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
  } catch (e) {
    console.log('  [popup-learner] Warning: Could not save memory file.', e.message);
  }
}

// ─── Fingerprinting ─────────────────────────────────────────────────────────

/**
 * Build a stable fingerprint from a popup's or page's text content.
 * We normalize the text (lowercase, strip extra whitespace, remove numbers
 * that might change between sessions like timestamps) and hash it.
 */
function computeFingerprint(textContent) {
  const normalized = textContent
    .toLowerCase()
    .replace(/\d+/g, '#')       // replace all numbers with # to stabilize
    .replace(/\s+/g, ' ')       // collapse whitespace
    .trim()
    .slice(0, 500);             // cap length so hash is consistent even if page is huge

  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
}

// ─── Button scoring ─────────────────────────────────────────────────────────

function scoreButton(buttonText) {
  const text = buttonText.trim();
  if (!text) return { score: -10, reason: 'empty' };

  let bestScore = 0;
  let bestReason = 'unknown';

  for (const [pattern, score, reason] of BUTTON_SCORE_RULES) {
    if (pattern.test(text)) {
      if (score < 0) {
        // Negative rules always take effect (they're blockers)
        return { score, reason };
      }
      if (score > bestScore) {
        bestScore = score;
        bestReason = reason;
      }
    }
  }

  return { score: bestScore, reason: bestReason };
}

// ─── Close-button detection (×, ✕, aria-label) ─────────────────────────────

/**
 * Check if an element is a close/dismiss icon button (×, ✕, ✖, X).
 * These are scored at +75.
 */
async function isCloseIconButton(elHandle) {
  try {
    const info = await elHandle.evaluate((el) => {
      const text = (el.textContent || '').trim();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      // Check for close icon characters
      const closeChars = ['×', '✕', '✖', '✗', '⨉', 'x'];
      const isCloseChar = closeChars.includes(text.toLowerCase()) || text === '';
      const isCloseAria = /close|dismiss|exit/i.test(ariaLabel) || /close|dismiss|exit/i.test(title);
      // Check if it's a small button (likely an icon button)
      const rect = el.getBoundingClientRect();
      const isSmall = rect.width < 60 && rect.height < 60;
      // SVG inside might indicate an icon
      const hasSvg = el.querySelector('svg') !== null;

      return {
        isCloseChar: isCloseChar && (isSmall || hasSvg),
        isCloseAria,
        text,
      };
    });
    return info.isCloseChar || info.isCloseAria;
  } catch {
    return false;
  }
}

// ─── Popup detection (universal DOM signals) ─────────────────────────────────

/**
 * Detect popups/modals/overlays on the page using universal DOM signals.
 * Returns an array of { element, frame, textContent, fingerprint, source }.
 */
async function detectPopups(page) {
  const detected = [];
  const frames = page.frames();

  for (const frame of frames) {
    try {
      // Strategy 1: ARIA-based modals
      const ariaModals = await frame.$$('[role="dialog"], [aria-modal="true"], dialog[open]');
      for (const el of ariaModals) {
        if (await isVisible(el)) {
          const text = await safeTextContent(el);
          detected.push({
            element: el,
            frame,
            textContent: text,
            fingerprint: computeFingerprint(text),
            source: 'aria-modal',
          });
        }
      }

      // Strategy 2: High z-index fixed/absolute overlays
      const overlays = await frame.evaluate(() => {
        const results = [];
        const allEls = document.querySelectorAll('*');
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;

        for (const el of allEls) {
          const style = window.getComputedStyle(el);
          const zIndex = parseInt(style.zIndex, 10);
          const position = style.position;

          if (zIndex > 999 && (position === 'fixed' || position === 'absolute')) {
            const rect = el.getBoundingClientRect();
            // Must cover a meaningful portion of the viewport
            const coverageW = rect.width / viewW;
            const coverageH = rect.height / viewH;
            if (coverageW > 0.3 && coverageH > 0.3) {
              // Must have visible content (not just a backdrop)
              const hasButtons = el.querySelectorAll('button, a, [role="button"]').length > 0;
              if (hasButtons) {
                // Generate a selector path we can use to re-find this element
                const id = el.id ? `#${el.id}` : null;
                const classes = el.className && typeof el.className === 'string'
                  ? '.' + el.className.trim().split(/\s+/).join('.')
                  : null;
                const selector = id || classes || null;
                results.push({
                  selector,
                  text: el.textContent.slice(0, 800),
                  tag: el.tagName,
                });
              }
            }
          }
        }
        return results;
      }).catch(() => []);

      for (const ov of overlays) {
        // Try to get an element handle for this overlay
        let el = null;
        if (ov.selector) {
          el = await frame.$(ov.selector).catch(() => null);
        }
        if (el && await isVisible(el)) {
          // Check we haven't already detected this one via ARIA
          const fp = computeFingerprint(ov.text);
          const isDuplicate = detected.some((d) => d.fingerprint === fp);
          if (!isDuplicate) {
            detected.push({
              element: el,
              frame,
              textContent: ov.text,
              fingerprint: fp,
              source: 'z-index-overlay',
            });
          }
        }
      }
    } catch {
      // Frame may have detached — skip it
    }
  }

  return detected;
}

// ─── Redirect detection ──────────────────────────────────────────────────────

/**
 * Check if the current URL indicates a redirect away from the course.
 * Returns { isRedirect: true, url } or { isRedirect: false }.
 */
function detectRedirect(currentUrl, lastLectureUrl) {
  if (!currentUrl || !lastLectureUrl) return { isRedirect: false };

  // If the URL is still the same, no redirect
  if (currentUrl === lastLectureUrl) return { isRedirect: false };

  // Check if the current URL matches known redirect patterns
  for (const pattern of REDIRECT_URL_PATTERNS) {
    if (pattern.test(currentUrl)) {
      return { isRedirect: true, url: currentUrl, reason: 'matched-redirect-pattern' };
    }
  }

  // Check if the current URL does NOT match any expected course URL
  const matchesCourse = COURSE_URL_PATTERNS.some((p) => p.test(currentUrl));
  if (!matchesCourse) {
    // It's a URL we don't recognize as part of the course — likely a redirect
    // But only flag it if the lastLectureUrl WAS a course URL (to avoid false positives on startup)
    const lastWasCourse = COURSE_URL_PATTERNS.some((p) => p.test(lastLectureUrl));
    if (lastWasCourse) {
      return { isRedirect: true, url: currentUrl, reason: 'left-course-url' };
    }
  }

  return { isRedirect: false };
}

// ─── Main handler: detect & dismiss any interruption ─────────────────────────

/**
 * The all-in-one function called from the main loop.
 * Checks for redirects first, then popups.
 * Returns true if something was handled, false otherwise.
 */
async function detectAndDismissAll(page, mediaFrame, lastLectureUrl) {
  const memory = loadMemory();

  // ── Step 1: Check for full-page redirects ──
  const currentUrl = page.url();
  const redirect = detectRedirect(currentUrl, lastLectureUrl);

  if (redirect.isRedirect) {
    console.log(`  ⚠ REDIRECT DETECTED — landed on: ${redirect.url}`);
    console.log(`    Reason: ${redirect.reason}`);

    // Try to find and click an exit/skip button on this page
    const handled = await handleRedirectPage(page, memory, redirect, lastLectureUrl);
    if (handled) return true;

    // If no button worked, navigate back
    console.log('  No suitable exit button found — navigating back to lecture...');
    try {
      await page.goto(lastLectureUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('  ✓ Returned to lecture page.');
    } catch {
      console.log('  Warning: Could not navigate back. Trying page.goBack()...');
      await page.goBack({ timeout: 15000 }).catch(() => {});
    }
    return true;
  }

  // ── Step 2: Check for popup overlays ──
  const popups = await detectPopups(page);

  for (const popup of popups) {
    // Check memory first
    const remembered = memory.fingerprints[popup.fingerprint];
    if (remembered) {
      console.log(`  📝 Recognized popup (seen ${remembered.successCount}x): "${remembered.description}"`);
      const success = await replayRememberedAction(page, popup, remembered, mediaFrame);
      if (success) {
        remembered.successCount++;
        remembered.lastSeen = new Date().toISOString();
        saveMemory(memory);
        return true;
      }
      // If remembered action failed, fall through to scoring
      console.log('  Remembered action failed — re-scoring buttons...');
    }

    // Score and click
    const success = await scoreAndDismiss(page, popup, memory, mediaFrame);
    if (success) return true;
  }

  // ── Step 3: Fallback — check for in-video quiz options (radio/checkbox) ──
  const quizHandled = await handleInVideoQuizOptions(page, mediaFrame);
  if (quizHandled) return true;

  return false;
}

// ─── Handle redirect pages ──────────────────────────────────────────────────

async function handleRedirectPage(page, memory, redirect, lastLectureUrl) {
  const mainFrame = page.mainFrame();

  // Get page text for fingerprinting
  const pageText = await mainFrame.evaluate(() => {
    return document.body ? document.body.textContent.slice(0, 800) : '';
  }).catch(() => '');

  const fingerprint = computeFingerprint(pageText);

  // Check memory
  const remembered = memory.fingerprints[fingerprint];
  if (remembered) {
    console.log(`  📝 Recognized redirect page (seen ${remembered.successCount}x): "${remembered.description}"`);
    // Try the remembered button
    const btn = await findButtonByText(mainFrame, remembered.action.buttonText);
    if (btn) {
      await btn.click({ timeout: 5000, force: true }).catch(() => {});
      await page.waitForTimeout(2000);
      remembered.successCount++;
      remembered.lastSeen = new Date().toISOString();
      saveMemory(memory);
      return true;
    }
  }

  // Score all buttons on the page
  const candidates = await scoreAllButtons(mainFrame);
  if (candidates.length === 0) {
    console.log('  No clickable buttons found on redirect page.');
    return false;
  }

  console.log('  Buttons found on redirect page:');
  for (const c of candidates.slice(0, 8)) {
    console.log(`    [${c.score}] "${c.text}" (${c.reason})`);
  }

  // Click the best one above threshold
  const best = candidates[0];
  if (best.score >= SAFE_SCORE_THRESHOLD) {
    console.log(`  → Clicking "${best.text}" (score: ${best.score}, reason: ${best.reason})`);
    try {
      await best.handle.click({ timeout: 5000, force: true });
      await page.waitForTimeout(2000);

      // Save to memory
      const desc = pageText.replace(/\s+/g, ' ').trim().slice(0, 80);
      memory.fingerprints[fingerprint] = {
        description: `Redirect page: ${desc}...`,
        sampleText: desc,
        action: { type: 'click', buttonText: best.text },
        successCount: 1,
        lastSeen: new Date().toISOString(),
        type: 'redirect',
      };
      saveMemory(memory);
      return true;
    } catch (e) {
      console.log(`  Failed to click "${best.text}": ${e.message}`);
    }
  } else {
    console.log(`  Best button "${best.text}" scored ${best.score} — below threshold (${SAFE_SCORE_THRESHOLD}). Skipping.`);
  }

  return false;
}

// ─── Score and dismiss a popup ──────────────────────────────────────────────

async function scoreAndDismiss(page, popup, memory, mediaFrame) {
  const candidates = await scoreAllButtonsInElement(popup.element, popup.frame);

  // Also check for close-icon buttons (×, ✕, aria-label=close)
  const closeButtons = await findCloseIconButtons(popup.element, popup.frame);
  for (const cb of closeButtons) {
    candidates.push({
      handle: cb.handle,
      text: cb.text || '×',
      score: 75,
      reason: 'close-icon',
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return false;
  }

  console.log(`  Popup detected [${popup.source}] (fingerprint: ${popup.fingerprint}):`);
  for (const c of candidates.slice(0, 6)) {
    console.log(`    [${c.score}] "${c.text}" (${c.reason})`);
  }

  // Try each candidate above threshold
  for (const candidate of candidates) {
    if (candidate.score < SAFE_SCORE_THRESHOLD) break;

    console.log(`  → Clicking "${candidate.text}" (score: ${candidate.score}, reason: ${candidate.reason})`);
    try {
      await candidate.handle.click({ timeout: 5000, force: true });
      await page.waitForTimeout(1000);

      // Check if popup disappeared
      const stillVisible = await isVisible(popup.element).catch(() => false);

      if (!stillVisible) {
        console.log('  ✓ Popup dismissed successfully.');

        // Resume playback if needed
        if (mediaFrame) {
          await resumeMedia(mediaFrame);
        }

        // Save to memory
        const desc = popup.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
        memory.fingerprints[popup.fingerprint] = {
          description: desc,
          sampleText: popup.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
          action: { type: 'click', buttonText: candidate.text },
          successCount: 1,
          lastSeen: new Date().toISOString(),
          type: 'popup',
          source: popup.source,
        };
        saveMemory(memory);
        return true;
      }

      // Popup still there — the click might have done something useful (e.g. submitted a quiz
      // step), so still count it and try the next candidate
      console.log('  Popup still visible after click — trying next button...');
    } catch (e) {
      console.log(`  Failed to click "${candidate.text}": ${e.message}`);
    }
  }

  return false;
}

// ─── Replay a remembered action ──────────────────────────────────────────────

async function replayRememberedAction(page, popup, remembered, mediaFrame) {
  try {
    const buttonText = remembered.action.buttonText;
    // Try to find the button inside the popup element
    let btn = await findButtonByTextInElement(popup.element, popup.frame, buttonText);

    // Fallback: search the whole frame
    if (!btn) {
      btn = await findButtonByText(popup.frame, buttonText);
    }

    if (btn && await isVisible(btn)) {
      console.log(`  → Replaying: click "${buttonText}"`);
      await btn.click({ timeout: 5000, force: true });
      await page.waitForTimeout(1000);

      if (mediaFrame) {
        await resumeMedia(mediaFrame);
      }
      return true;
    }
  } catch (e) {
    console.log(`  Replay failed: ${e.message}`);
  }
  return false;
}

// ─── In-video quiz option handling ───────────────────────────────────────────

const OPTION_SELECTORS = [
  'input[type="radio"]',
  'input[type="checkbox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '.rc-Option',
  '.rc-FormOption input',
  'label:has(input[type="radio"])',
  'label:has(input[type="checkbox"])',
];

async function handleInVideoQuizOptions(page, mediaFrame) {
  const frames = page.frames();

  for (const frame of frames) {
    try {
      for (const sel of OPTION_SELECTORS) {
        const optionEl = await frame.$(sel);
        if (optionEl && await isVisible(optionEl)) {
          const isChecked = await optionEl.isChecked().catch(() => false);
          if (!isChecked) {
            console.log('  In-video quiz option detected — selecting first option...');
            await optionEl.click({ timeout: 2000, force: true }).catch(() => {});
            await page.waitForTimeout(300);

            // Now look for a submit/continue button nearby
            const submitBtn = await findSubmitButton(frame);
            if (submitBtn) {
              console.log('  Submitting in-video quiz answer...');
              await submitBtn.click({ timeout: 5000, force: true }).catch(() => {});
              await page.waitForTimeout(1000);
              if (mediaFrame) {
                await resumeMedia(mediaFrame);
              }
            }
            return true;
          }
        }
      }
    } catch {
      // Frame may have detached
    }
  }

  return false;
}

async function findSubmitButton(frame) {
  const submitSelectors = [
    'button:has-text("Submit")',
    'button:has-text("Check")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Submit")',
  ];

  for (const sel of submitSelectors) {
    try {
      const btn = await frame.$(sel);
      if (btn && await isVisible(btn)) {
        return btn;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

// ─── Utility: score all buttons in a frame ───────────────────────────────────

async function scoreAllButtons(frame) {
  const candidates = [];
  const buttonElements = await frame.$$('button, a, [role="button"]').catch(() => []);

  for (const el of buttonElements) {
    try {
      if (!await isVisible(el)) continue;

      const text = await safeInnerText(el);
      if (!text && !await isCloseIconButton(el)) continue;

      // Check for close icon
      if (await isCloseIconButton(el)) {
        candidates.push({ handle: el, text: text || '×', score: 75, reason: 'close-icon' });
        continue;
      }

      const { score, reason } = scoreButton(text);
      candidates.push({ handle: el, text, score, reason });
    } catch {
      // Element may have become stale
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function scoreAllButtonsInElement(parentEl, frame) {
  const candidates = [];

  try {
    const buttonElements = await parentEl.$$('button, a, [role="button"]');

    for (const el of buttonElements) {
      try {
        if (!await isVisible(el)) continue;

        const text = await safeInnerText(el);
        if (!text && !await isCloseIconButton(el)) continue;

        if (await isCloseIconButton(el)) {
          candidates.push({ handle: el, text: text || '×', score: 75, reason: 'close-icon' });
          continue;
        }

        const { score, reason } = scoreButton(text);
        candidates.push({ handle: el, text, score, reason });
      } catch {
        // stale element
      }
    }
  } catch {
    // parent may have been removed
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ─── Utility: find close icon buttons ────────────────────────────────────────

async function findCloseIconButtons(parentEl, frame) {
  const results = [];
  try {
    const allButtons = await parentEl.$$('button, [role="button"]');
    for (const el of allButtons) {
      if (await isCloseIconButton(el) && await isVisible(el)) {
        const text = await safeInnerText(el);
        results.push({ handle: el, text });
      }
    }
  } catch {
    // ignore
  }
  return results;
}

// ─── Utility: find a button by its visible text ──────────────────────────────

async function findButtonByText(frame, targetText) {
  const normalized = targetText.toLowerCase().trim();
  try {
    const buttons = await frame.$$('button, a, [role="button"]');
    for (const btn of buttons) {
      const text = await safeInnerText(btn);
      if (text.toLowerCase().trim() === normalized && await isVisible(btn)) {
        return btn;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function findButtonByTextInElement(parentEl, frame, targetText) {
  const normalized = targetText.toLowerCase().trim();
  try {
    const buttons = await parentEl.$$('button, a, [role="button"]');
    for (const btn of buttons) {
      const text = await safeInnerText(btn);
      if (text.toLowerCase().trim() === normalized && await isVisible(btn)) {
        return btn;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ─── Utility: visibility check ───────────────────────────────────────────────

async function isVisible(elHandle) {
  try {
    return await elHandle.isVisible();
  } catch {
    return false;
  }
}

// ─── Utility: safe text extraction ───────────────────────────────────────────

async function safeTextContent(elHandle) {
  try {
    return (await elHandle.textContent()) || '';
  } catch {
    return '';
  }
}

async function safeInnerText(elHandle) {
  try {
    const text = await elHandle.innerText();
    return (text || '').trim().replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

// ─── Utility: resume media playback ──────────────────────────────────────────

async function resumeMedia(frame) {
  try {
    await frame.evaluate(() => {
      const m = document.querySelector('video, audio');
      if (m && m.paused) m.play().catch(() => {});
    });
  } catch {
    // frame may have detached
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  detectAndDismissAll,
  detectPopups,
  detectRedirect,
  scoreButton,
  loadMemory,
  saveMemory,
  computeFingerprint,
  COURSE_URL_PATTERNS,
};

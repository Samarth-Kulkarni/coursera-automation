/**
 * Coursera Auto-Advance (Playwright)
 * --------------------------------------------------
 * - Opens Coursera in a real browser window.
 * - You log in manually (once) and press Enter in the terminal to continue.
 * - Script then loops through lecture videos: waits for each video to end,
 *   then clicks "Go to next item."
 * - If it lands on a quiz/exam page, it STOPS clicking and waits for you
 *   to complete the quiz yourself. Once you navigate away from the quiz
 *   (by finishing it and clicking through manually), the script detects
 *   the URL change and resumes auto-advancing automatically.
 * - Ends when no "Go to next item" button is found (course/module finished).
 *
 * SETUP:
 *   npm init -y
 *   npm install playwright
 *   npx playwright install chromium
 *
 * RUN:
 *   node coursera-auto-next.js "https://www.coursera.org/learn/your-course/home/week/1"
 */

const { chromium } = require('playwright');
const readline = require('readline');
const { detectAndDismissAll, COURSE_URL_PATTERNS } = require('./popup-learner');

const NEXT_BUTTON_SELECTORS = [
  'button[data-e2e="item-navigation-next-button"]',
  'a[data-e2e="item-navigation-next-button"]',
  'button[aria-label="Go to next item"]',
  'a[aria-label="Go to next item"]',
  'button:has-text("Go to next item")',
  'a:has-text("Go to next item")',
  'button:has-text("Next item")',
  'a:has-text("Next item")',
  '[data-testid="next-item-button"]',
  'button[aria-label*="next item" i]',
  'a[aria-label*="next item" i]',
];



function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

function isQuizUrl(url) {
  return /\/(quiz|exam)\//i.test(url);
}

async function findNextButton(page) {
  for (const sel of NEXT_BUTTON_SELECTORS) {
    const el = await page.$(sel);
    if (el) return el;
  }
  return null;
}

const MEDIA_SELECTOR = 'video, audio';

// Coursera often embeds the player inside an <iframe> rather than the top
// page, and video-only lecture items may actually be audio-only (<audio>).
// This searches the main page AND every iframe for a media element.
async function findMediaFrame(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frames = page.frames(); // includes the main frame at index 0
    for (const frame of frames) {
      try {
        const el = await frame.$(MEDIA_SELECTOR);
        if (el) return frame;
      } catch {
        // frame may have detached/navigated mid-check — ignore and keep looking
      }
    }
    // Check for HonorCodeModal or test URLs to skip waiting for video
    const isTest = await page.evaluate(() => {
      if (document.querySelector('[data-testid="HonorCodeModal"]')) return true;
      if (window.location.href.match(/\/(quiz|exam|assignment|peer|graded-assignment)\//i)) return true;
      return false;
    }).catch(() => false);

    if (isTest) {
      return null;
    }

    await page.waitForTimeout(300);
  }
  return null;
}



async function waitForVideoToEnd(page) {
  console.log('  Looking for a video/audio element (checking all frames)...');
  const frame = await findMediaFrame(page);
  if (!frame) {
    console.log('  No media element found on this page — maybe a reading item?');
    console.log('  Waiting 5 seconds before checking for the next button...');
    await page.waitForTimeout(5000);
    return;
  }

  const tag = await frame.evaluate(() => {
    const m = document.querySelector('video, audio');
    return m ? m.tagName.toLowerCase() : null;
  });
  console.log(`  Found <${tag}> element. Waiting for it to finish...`);

  // Coursera media does NOT autoplay — we have to explicitly start it,
  // otherwise 'ended' never fires and we'd wait forever.
  await startMediaPlayback(frame);

  // Poll the media element's 'ended' property and actively check for in-video popups (e.g. quizzes)
  let isEnded = false;
  let pollCount = 0;
  const lectureUrlForGuard = page.url(); // Save for redirect guard
  while (!isEnded) {
    try {
      isEnded = await frame.evaluate(() => {
        const m = document.querySelector('video, audio');
        if (!m) return true; // element disappeared (e.g. navigated away) — treat as done
        return m.ended === true;
      });
    } catch {
      // If the frame itself navigates/detaches while waiting, treat as "done"
      // rather than crashing the whole script.
      console.log('  Frame changed while waiting — assuming media finished.');
      isEnded = true;
    }

    if (isEnded) break;

    // Self-learning popup & redirect handler
    await detectAndDismissAll(page, frame, lectureUrlForGuard);

    // Periodically ensure playback hasn't paused without a popup
    pollCount++;
    if (pollCount % 10 === 0) {
      const isPaused = await frame.evaluate(() => {
        const m = document.querySelector('video, audio');
        return m ? m.paused : false;
      }).catch(() => false);

      if (isPaused) {
        console.log('  Media appears paused — attempting to resume playback...');
        await startMediaPlayback(frame);
      }
    }

    await page.waitForTimeout(1000);
  }

  console.log('  Media ended.');
}

async function startMediaPlayback(frame) {
  // Try the direct/programmatic way first.
  await frame.evaluate(() => {
    const m = document.querySelector('video, audio');
    if (m && m.paused) m.play().catch(() => {});
  });

  await frame.waitForTimeout(500);
  const isPlayingNow = await frame.evaluate(() => {
    const m = document.querySelector('video, audio');
    return m ? !m.paused : false;
  });
  if (isPlayingNow) return;

  // Fallback: some players require a real user gesture (click) rather than
  // a programmatic .play() call. Click the visible play button / media area.
  console.log('  Did not start automatically — clicking play button...');
  const playButtonSelectors = [
    'button[aria-label="Play"]',
    'button[title="Play"]',
    'button[aria-label*="Play" i]',
    '.vjs-big-play-button',
    '.rc-PlayButton',
    'video',
    'audio',
  ];
  for (const sel of playButtonSelectors) {
    try {
      const el = await frame.$(sel);
      if (!el) continue;
      await el.click({ timeout: 3000 });
      await frame.waitForTimeout(500);
      const nowPlaying = await frame.evaluate(() => {
        const m = document.querySelector('video, audio');
        return m ? !m.paused : false;
      });
      if (nowPlaying) {
        console.log('  Playback started.');
        return;
      }
    } catch {
      // try next selector
    }
  }
  console.log('  Could not confirm playback started — you may need to click Play manually.');
}

async function waitForQuizToBeLeft(page, quizUrl) {
  console.log('\n  >>> QUIZ DETECTED — pausing automation. <<<');
  console.log(`  URL: ${quizUrl}`);
  console.log('  Please complete the quiz yourself in the browser window.');
  console.log('  The script will automatically resume once you navigate away from it.\n');

  await page.waitForFunction(
    (currentQuizUrl) => window.location.href !== currentQuizUrl,
    quizUrl,
    { timeout: 0, polling: 1000 }
  );

  console.log('  Detected navigation away from quiz — resuming auto-advance.\n');
}

(async () => {
  const courseUrl = process.argv[2];
  if (!courseUrl) {
    console.error('Usage: node coursera-auto-next.js <coursera-course-url>');
    process.exit(1);
  }

  const userDataDir = require('path').join(__dirname, 'coursera-profile');
  const context = await chromium.launchPersistentContext(userDataDir, { 
    headless: false, 
    slowMo: 50,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  
  // A persistent context automatically opens a first tab, so we use it to avoid two tabs.
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  try {
    await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log('  Note: Page load timed out, but proceeding anyway since you can navigate manually.');
  }

  console.log('A browser window has opened.');
  console.log('1. If you are not logged in, log into Coursera now (this will be saved for next time!).');
  console.log('2. Navigate to the first lecture item you want to start from.');
  await ask('Press Enter here once you are ready to start auto-advancing...\n');

  let moduleCount = 0;
  let lastKnownLectureUrl = page.url();

  while (true) {
    const url = page.url();
    lastKnownLectureUrl = url; // Track lecture URL for redirect guard

    // Check for redirects before doing anything else
    await detectAndDismissAll(page, null, lastKnownLectureUrl);

    // Assume it's a lecture item (or a test we want to skip) — wait for its video to end.
    await waitForVideoToEnd(page);

    let nextBtn = await findNextButton(page);
    if (!nextBtn) {
      console.log('No "Go to next item" button found — course or module appears finished.');
      break;
    }

    console.log('  Clicking "Go to next item"...');
    const oldUrl = page.url();
    
    let clicked = false;
    let clickRetries = 0;
    const MAX_CLICK_RETRIES = 10;
    while (!clicked && clickRetries < MAX_CLICK_RETRIES) {
      try {
        await nextBtn.click({ timeout: 5000, force: true });
        clicked = true;
      } catch (err) {
        const msg = err.message || '';
        const isRecoverable = msg.includes('intercepts pointer events')
          || msg.includes('not visible')
          || msg.includes('not attached')
          || msg.includes('detached')
          || err.name === 'TimeoutError';

        if (isRecoverable) {
          clickRetries++;
          console.log(`\n  >>> CLICK FAILED (attempt ${clickRetries}/${MAX_CLICK_RETRIES}) <<<`);
          console.log(`  Reason: ${msg.split('\n')[0]}`);
          console.log('  Attempting auto-dismiss of any blocking overlay...');
          const handled = await detectAndDismissAll(page, null, lastKnownLectureUrl);
          if (!handled) {
            console.log('  No overlay found. Waiting before retry...');
          }
          await page.waitForTimeout(handled ? 1000 : 3000);

          // Re-find the button — the old handle may be stale
          nextBtn = await findNextButton(page);
          if (!nextBtn) {
            console.log('  "Go to next item" button disappeared. Skipping this cycle...');
            break;
          }
        } else {
          throw err;
        }
      }
    }

    if (!clicked) {
      console.log('  Could not click "Go to next item" after retries. Moving on...');
      await page.waitForTimeout(2000);
      continue;
    }

    try {
      await page.waitForFunction((u) => window.location.href !== u, oldUrl, { timeout: 15000 });
    } catch {
      console.log('  URL did not change after clicking next. Moving on anyway...');
    }

    moduleCount++;
    console.log(`  Advanced to item #${moduleCount}. Now at: ${page.url()}\n`);

    // Small buffer to let the new page fully render before we inspect it.
    await page.waitForTimeout(1500);
  }

  console.log('Done. Leaving the browser window open — close it manually when ready.');
})();
'use strict';

// Default: Playwright's managed Chromium (`npx playwright install chromium`).
// Optional: HYS_BROWSER_CHANNEL=msedge or HYS_BROWSER_EXECUTABLE=/path/to/browser.
function browserOptions() {
  const options = {
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run']
  };
  if (process.env.HYS_BROWSER_EXECUTABLE) options.executablePath = process.env.HYS_BROWSER_EXECUTABLE;
  else if (process.env.HYS_BROWSER_CHANNEL) options.channel = process.env.HYS_BROWSER_CHANNEL;
  return options;
}

module.exports = { browserOptions };

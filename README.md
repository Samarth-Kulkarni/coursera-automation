# Coursera Auto-Next (Playwright Automation)

A Playwright-based browser automation script designed to auto-advance through lecture videos and pause automatically when quizzes, exams, or modal prompts appear.

> **Note:** This repository is for personal educational and demonstration purposes only.

## Features
- **Browser Session Persistence:** Saves authentication in a local profile so you only need to log in once.
- **Media Event Detection:** Monitors `<video>` and `<audio>` tags across all page frames and auto-plays lectures.
- **Popup Handling:** Automatically handles in-video "Skip" or "Continue" popups.
- **Quiz Pause:** Detects quiz/exam pages, pauses automation for manual completion, and resumes auto-advancing once you navigate away.

## Prerequisites
- [Node.js](https://nodejs.org/) (v16 or higher)

## Installation

1. Clone the repository:
   ```bash
   git clone <your-repository-url>
   cd coursera-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Install Playwright browser binaries:
   ```bash
   npx playwright install chromium
   ```

## Usage

Run the script with the URL of the Coursera course week or module:

```bash
node coursera-auto-next.js "https://www.coursera.org/learn/your-course/home/week/1"
```

1. Log into your Coursera account in the opened browser window (if prompted).
2. Navigate to your starting lecture.
3. Press `Enter` in the terminal to begin auto-advancing.

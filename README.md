# Market Mayhem

A stock-market simulation game played with **fictional companies**, plus the website that hosts it.

**Live site:** https://eic-om7n.onrender.com/

> **Unofficial project.** This is an independent, student-made site. It is not an official website of, and is not endorsed by, any institution or club. All companies, prices and events are fictional. Nothing here is investment advice.

## About the site

This site is the home of Market Mayhem. It is a single-page website with an animated 3D "startup city" background that you scroll through. From it, players can find out about the game, follow the rounds and check the market board. The round packs themselves are PDFs, one per round.

---

## Table of contents

1. [About the site](#about-the-site)
2. [The game in one minute](#the-game-in-one-minute)
3. [Rules](#rules)
4. [Scoring](#scoring)
5. [The round packs (PDFs)](#the-round-packs-pdfs)
6. [How the PDFs are generated](#how-the-pdfs-are-generated)
7. [Reading a company sheet](#reading-a-company-sheet)
8. [Round 1 companies](#round-1-companies)
9. [Hosting a game](#hosting-a-game)
10. [The website](#the-website)
11. [Running locally](#running-locally)
12. [Contributing](#contributing)

---

## The game in one minute

Every team starts with **₹1,00,000** of virtual cash and a set of fictional companies. Each round, organisers release an information pack for every company. Teams read it, decide what to buy, hold or avoid, and submit their orders. The market then moves, portfolios are updated, and the next round begins. The team with the highest portfolio value at the end wins.

No real market data is used, so nobody can win by looking things up. The only edge is reading the pack well.

## Rules

> Items marked `TODO` are not in the Round 1 pack. Fill them in with your actual decisions before publishing.

### Setup
1. Each team starts with **₹1,00,000** in virtual cash.
2. Round 1 has **5 companies**: RELY, ADHI, TATV, INFY-R and SMBR. Later rounds may change the list (`TODO`: confirm).
3. Team size: `TODO` (for example 2 to 4 players).
4. Number of rounds: `TODO`.

### Each round
1. The round's information pack is released (see [The round packs](#the-round-packs-pdfs)).
2. Teams study the data and submit orders (buy, sell or hold, and how much) before the deadline.
3. Orders are executed at the **close price shown in the pack** (`TODO`: confirm).
4. The market's next move is revealed and every portfolio is revalued.
5. Cash left over carries into the next round.

### Trading rules
Decide and fill in each of these:

| Question | Suggested default | Your decision |
|----------|-------------------|---------------|
| Whole shares only, or fractions allowed? | Whole shares | `TODO` |
| Maximum share of the portfolio in one company | 40% | `TODO` |
| Short selling allowed? | No | `TODO` |
| Brokerage or transaction fees? | None | `TODO` |
| Can a team stay fully in cash? | Yes | `TODO` |
| Late submissions | Not accepted | `TODO` |

### Fair play
- Decisions must be based only on the information in the packs. The companies are fictional, so outside data does not apply.
- Each team submits its own orders. Copying another team's portfolio is not allowed.
- Organisers' decisions on disputes are final.

## Scoring

> `TODO`: confirm the final scoring.

- **Main score:** final portfolio value (cash plus the value of all holdings) after the last round.
- **Tie-break:** higher return in the final round.
- **Optional:** a short written reason for each trade earns bonus points, so skill counts for more than luck.

---

## The round packs (PDFs)

Each round is released as a single PDF. For Round 1:

- **10 pages** in total: **2 pages per company**, for 5 companies.
- Page order is Numbers then Graphs for each company, in the order RELY, ADHI, TATV, INFY-R, SMBR.
- Every page header shows the ticker, company name, sector, round, and the team's starting cash. Footers read "Fictional companies and prices" and give the page number.

**Numbers page** is a table of 10 features, each with its meaning, plus a one-line **Economy and sector** note.

**Graphs page** has three charts:

| Chart | What it shows |
|-------|---------------|
| Closing price, last month (daily) | 21 points: the open price, then days 1 to 20. A dotted line marks the open price, and the first and last points are labelled. The line is **green** if the month closed above the open, **red** if below. |
| Weekly volume (lakh shares) | 26 weekly bars. The last 4 weeks are dark blue and the earlier ones light. A dashed line marks the previous 3-month average. |
| P/E ratio vs sector average | Two bars: the company and its sector. |

## How the PDFs are generated

> `TODO`: replace the tooling and file names below with what you actually use. I could only see the finished PDF, not your generator, so the steps describe what the output shows.

Packs are produced from a single data file per round, not made by hand. The goal is that a round can be regenerated, corrected and audited.

### 1. Input data
For each company, one record holds the **raw inputs**:

- ticker, name, sector
- open price, close price
- daily closing prices for the month (21 values)
- weekly volumes for the last 26 weeks, and the previous 3-month average
- P/E ratio and sector average P/E
- debt-to-equity ratio
- news sentiment score (-100 to +100)
- EPS growth (year-on-year)
- block deal (None, or Buy/Sell with a stake %)
- economy and sector note

### 2. Derived values
Some fields are calculated so the pack never contradicts itself:

- **1-month change** = (close − open) ÷ open × 100. Checked against the Round 1 pack, this matches for all 5 companies (for example RELY: (2880.00 − 2903.73) ÷ 2903.73 = −0.82%).
- **Volume vs previous 3-month average** compares the last 4 weekly volumes with the previous 3-month average shown as the dashed line.
- **Chart colour** (green or red) follows the sign of the 1-month change.
- The final point of the daily series equals the close price, and the first equals the open price.

### 3. Rendering
- Charts are drawn from the data as images or vector graphics (`TODO`: library).
- Pages are laid out from a shared template: dark header band, content area, footer (`TODO`: PDF library).
- Pages are assembled in company order and exported as one PDF per round.

### 4. Checks before release
- [ ] Open and close in the table match the first and last points on the chart
- [ ] 1-month change matches open and close
- [ ] Volume percentage matches the bars and the dashed line
- [ ] P/E and sector P/E match between the table and the bar chart
- [ ] Block deal wording is consistent across both pages
- [ ] Tickers, sectors and page numbers are correct
- [ ] The packs are tested on a phone screen, since many players will read them there

### 5. Designing the data
Each company is built around a **story** that the signals either confirm or contradict, so teams must weigh evidence rather than react to one number. Keep the answer key (what really happens next) **private** until after the round closes. Do not publish the generator's hidden settings alongside the packs.

---

## Reading a company sheet

| Feature | What it tells you |
|---------|-------------------|
| Open / Close price | Where the stock started and ended last month |
| 1-month change | Percentage move from open to close |
| Volume vs previous 3-month average | Whether more or fewer shares than usual traded. A big move on high volume suggests conviction. |
| P/E ratio | Price divided by earnings per share. Higher means more expensive. |
| Sector average P/E | A benchmark for whether the stock is cheap or expensive against its peers |
| Debt-to-equity | Total debt divided by shareholders' equity. Higher means more financial risk. |
| News sentiment score | Mood of the month's news, from -100 to +100 |
| EPS growth (year-on-year) | How fast earnings per share are growing |
| Block deal | A very large single trade, shown as Buy or Sell with the stake %. It often signals what big players think. |
| Economy and sector | Context that may move the whole sector |

## Round 1 companies

| Ticker | Company | Sector | Close price |
|--------|---------|--------|-------------|
| RELY | Relyant Industries | Energy, retail, telecom | ₹2,880.00 |
| ADHI | Adhira Ports & Infra | Ports, airports, power | ₹2,350.00 |
| TATV | Tatva Motors | Automobiles | ₹960.00 |
| INFY-R | Infyra Technologies | IT services | ₹1,540.00 |
| SMBR | Sambar from Una | Food services | ₹410.00 |

### Round packs

All five round packs are available to download so anyone can play or host.

| Round | PDF |
|-------|-----|
| 1 | [Download](https://eic-om7n.onrender.com/rounds/round1.pdf) |
| 2 | [Download](https://eic-om7n.onrender.com/rounds/round2.pdf) |
| 3 | [Download](https://eic-om7n.onrender.com/rounds/round3.pdf) |
| 4 | [Download](https://eic-om7n.onrender.com/rounds/round4.pdf) |
| 5 | [Download](https://eic-om7n.onrender.com/rounds/round5.pdf) |

Hosts: if you want players to see rounds one at a time, release each file only when that round starts.

---

## Hosting a game

This section is for anyone running a game without the original creator.

**Host password:** `Kartik#28`

> The password is in a public README, so it is visible to every player. Please don't use host controls to look ahead or change results. The game relies on trust.

### Before the game
1. Open the live site: https://eic-om7n.onrender.com/
2. Log in to host mode with the password above (`TODO`: say where the host login is on the site).
3. Download the five round PDFs from [Round packs](#round-packs) and keep them ready.
4. Decide the open rules (see [Rules](#rules)): team size, share limits, short selling, fees and deadlines. Announce them before round 1.
5. Register the teams and give each ₹1,00,000 starting cash.

### During each round
1. Release that round's PDF to the players. Don't share later rounds early.
2. Give teams a fixed time to study the pack and submit their orders.
3. Collect the orders and check them against the trading rules.
4. Reveal how the market moved and update each team's portfolio value and cash.
5. Announce the standings, then move to the next round.

### After the final round
1. Announce the final portfolio values and the winner.
2. Explain what each company's signals really meant, so players learn from it.
3. Optionally share all the PDFs and results as an archive.

---

## The website

The site is a single-page experience with a 3D animated background, built with:

- [Vite](https://vite.dev/)
- [Three.js](https://threejs.org/) for the 3D scene
- [GSAP](https://gsap.com/) for animation
- Plain HTML and CSS

It is deployed on Render at https://eic-om7n.onrender.com/.

```
.
├── index.html        # page markup
├── package.json
├── public/           # static assets (logo)
└── src/
    ├── main.js       # 3D scene, animation, UI logic
    └── style.css     # styling
```

## Running locally

Requires Node.js 18 or newer.

```bash
git clone https://github.com/kartik28-debug/eic1.git
cd eic1
npm install
npm run dev        # development server
npm run build      # production build into /dist
npm run preview    # preview the production build
```

For deployment on Render as a static site, use build command `npm install && npm run build` and publish directory `dist`.

## Contributing

1. Fork the repo and create a branch.
2. Make your change and run `npm run build` to check it compiles.
3. Open a pull request describing what changed and why.

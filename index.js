// index.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));

// In-memory storage
const kudos = {};        // { userId: points }
const domains = {};      // { domainName: true }
const expertise = {};    // { userId: [domainName] }
const badges = {};       // { userId: [badgeName] }
const questions = {};    // { questionId: { text, domain, author, taggedExperts, answers: [] } }

// Helper to send Slack blocks
async function postToSlack(blocks) {
  try {
    await axios.post(process.env.SLACK_WEBHOOK_URL, { blocks });
  } catch (err) {
    console.error("Slack webhook error:", err.message);
  }
}

// Slash commands handler
app.post("/slack/commands", async (req, res) => {
  const { command, text, user_id, user_name } = req.body;
  res.send(""); // Immediate response to Slack

  const args = text.split(" ");
  const firstArg = args[0];

  // ================== /kudos ==================
  if (command === "/kudos") {
    const points = 5;
    kudos[user_id] = (kudos[user_id] || 0) + points;
    const total = kudos[user_id];

    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `:tada: *Kudos to <@${user_id}>!*` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Why:* ${text}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Points:* ${points} 🎉  | *Total:* ${total} :star2:` } }
    ];
    await postToSlack(blocks);
  }

  // ================== /badge ==================
  else if (command === "/badge") {
    const action = args[0];
    const targetUser = args[1]?.replace("@", "");
    const badgeName = args.slice(2).join(" ");

    if (action === "give" && targetUser && badgeName) {
      badges[targetUser] = badges[targetUser] || [];
      badges[targetUser].push(badgeName);
      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `:medal: <@${targetUser}> earned *${badgeName}* badge!` } }
      ]);
    } else if (action === "show") {
      const target = args[1] ? args[1].replace("@", "") : user_id;
      const userBadges = badges[target]?.join(", ") || "No badges yet.";
      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `:star2: <@${target}>'s badges: ${userBadges}` } }
      ]);
    }
  }

  // ================== /domain ==================
  else if (command === "/domain") {
    const action = args[0];
    const domainName = args.slice(1).join(" ");
    if (action === "add" && domainName) {
      domains[domainName] = true;
      expertise[user_id] = expertise[user_id] || [];
      if (!expertise[user_id].includes(domainName)) expertise[user_id].push(domainName);

      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `:bulb: <@${user_id}> added *${domainName}* to their domains.` } }
      ]);
    } else if (action === "list") {
      const allDomains = Object.keys(domains).join(", ") || "No domains yet.";
      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `:scroll: Current domains: ${allDomains}` } }
      ]);
    } else if (action === "show") {
      const userDomains = (expertise[user_id] || []).join(", ") || "No domains yet.";
      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `:bulb: <@${user_id}>'s domains: ${userDomains}` } }
      ]);
    }
  }

  // ================== /question ==================
  else if (command === "/question") {
    const domain = args[0];
    const questionText = args.slice(1).join(" ");
    const questionId = uuidv4();

    // Auto-tag experts
    const taggedExperts = [];
    for (const [uid, userDomains] of Object.entries(expertise)) {
      if (userDomains.includes(domain) && uid !== user_id) taggedExperts.push(`<@${uid}>`);
    }

    questions[questionId] = {
      text: questionText,
      domain,
      author: user_id,
      taggedExperts,
      answers: []
    };

    await postToSlack([
      { type: "section", text: { type: "mrkdwn", text: `:question: *New Question about ${domain}*\n*ID:* ${questionId}\nPosted by <@${user_id}>:\n"${questionText}"` } },
      { type: "section", text: { type: "mrkdwn", text: `:bulb: Experts tagged: ${taggedExperts.join(", ") || "None"}` } }
    ]);
  }

  // ================== /answer ==================
  else if (command === "/answer") {
    const questionId = args[0];
    const remainingArgs = args.slice(1);

    if (!questions[questionId]) return;

    if (remainingArgs[0] === "best") {
      // Only question author can mark best answer
      if (questions[questionId].author !== user_id) {
        await postToSlack([
          { type: "section", text: { type: "mrkdwn", text: `:no_entry: Only the question author can mark the best answer.` } }
        ]);
        return;
      }

      const bestAnswerText = remainingArgs.slice(1, -1).join(" ");
      const badgeName = remainingArgs[remainingArgs.length - 1];

      const answerObj = questions[questionId].answers.find(a => a.text === bestAnswerText);
      if (!answerObj) {
        await postToSlack([
          { type: "section", text: { type: "mrkdwn", text: `:warning: Answer not found for question ${questionId}.` } }
        ]);
        return;
      }

      answerObj.best = true;

      // Award points
      const bonusPoints = 10;
      kudos[answerObj.user] = (kudos[answerObj.user] || 0) + bonusPoints;

      // Award optional badge
      if (badgeName && badgeName !== bestAnswerText) {
        badges[answerObj.user] = badges[answerObj.user] || [];
        badges[answerObj.user].push(badgeName);
      }

      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `:tada: *Best Answer!* <@${answerObj.user}> for question ${questionId}` } },
        { type: "section", text: { type: "mrkdwn", text: `Awarded ${bonusPoints} points${badgeName ? ` and badge *${badgeName}*` : ""}!` } }
      ]);
    } else {
      const answerText = remainingArgs.join(" ");
      const answerObj = { user: user_id, text: answerText, best: false };
      questions[questionId].answers.push(answerObj);

      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `💡 <@${user_id}> answered question *${questionId}*:\n"${answerText}"` } }
      ]);
    }
  }

  // ================== /leaderboard ==================
  else if (command === "/leaderboard") {
    const sorted = Object.entries(kudos)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const leaderboardText = sorted
      .map(([uid, total], i) => `${i + 1}. <@${uid}> — *${total} points*`)
      .join("\n") || "No kudos yet.";

    await postToSlack([
      { type: "section", text: { type: "mrkdwn", text: ":trophy: *Leaderboard*" } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: leaderboardText } }
    ]);
  }

  // ================== /question-query ==================
  else if (command === "/question-query") {
    const domain = args[0];
    const filteredQuestions = Object.entries(questions)
      .filter(([id, q]) => !domain || q.domain === domain)
      .map(([id, q]) => {
        const bestAnswer = q.answers.find(a => a.best);
        return `*${id}* — ${q.text} (posted by <@${q.author}>)${bestAnswer ? `\n:tada: Best Answer: "${bestAnswer.text}" by <@${bestAnswer.user}>` : ""}`;
      })
      .join("\n") || "No questions found.";

    await postToSlack([
      { type: "section", text: { type: "mrkdwn", text: `:scroll: Questions${domain ? " about " + domain : ""}:\n${filteredQuestions}` } }
    ]);
  }
});

// ================== Auto-complete endpoints ==================

// Return matching domains for Slack auto-complete
app.post("/slack/options-domain", (req, res) => {
  const { value } = req.body; // what user typed
  const options = Object.keys(domains)
    .filter(d => d.toLowerCase().includes((value || "").toLowerCase()))
    .map(d => ({ text: { type: "plain_text", text: d }, value: d }));

  res.json({ options });
});

// Return matching badges for Slack auto-complete
app.post("/slack/options-badge", (req, res) => {
  const { value } = req.body;
  // Gather all existing badges across users
  const allBadges = new Set();
  Object.values(badges).forEach(list => list.forEach(b => allBadges.add(b)));

  const options = Array.from(allBadges)
    .filter(b => b.toLowerCase().includes((value || "").toLowerCase()))
    .map(b => ({ text: { type: "plain_text", text: b }, value: b }));

  res.json({ options });
});


// Landing page
app.get("/", (req, res) => {
  res.send('<h1>BadgeUp</h1><a href="/slack/install">Add to Slack</a>');
});

// Slack OAuth install route
app.get("/slack/install", (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  const redirectUri = process.env.REDIRECT_URI;
  const slackUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=commands,chat:write,users:read&redirect_uri=${redirectUri}`;
  res.redirect(slackUrl);
});

// Slack OAuth callback
app.get("/slack/oauth/callback", (req, res) => {
  res.send("Slack OAuth callback hit! BadgeUp is installed.");
});

app.listen(PORT, () => {
  console.log(`🚀 BadgeUp running on port ${PORT}`);
});

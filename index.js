require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();

// Slack sends application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --------------------
// In-memory storage (MVP only)
// --------------------
const kudos = {};
const expertise = {};

// --------------------
// Home Page
// --------------------
app.get("/", (req, res) => {
  res.send(`
    <h1>BadgeUp</h1>
    <p>Highlight who to ask about what.</p>
    <a href="https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=commands,chat:write,users:read&redirect_uri=${process.env.REDIRECT_URI}">
      <button>Add to Slack</button>
    </a>
  `);
});

// --------------------
// OAuth Callback
// --------------------
app.get("/slack/oauth/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const response = await axios.post(
      "https://slack.com/api/oauth.v2.access",
      null,
      {
        params: {
          code,
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          redirect_uri: process.env.REDIRECT_URI,
        },
      }
    );

    if (!response.data.ok) {
      return res.send("OAuth failed");
    }

    res.send("✅ BadgeUp installed successfully! You can close this tab.");
  } catch (err) {
    res.status(500).send("OAuth error");
  }
});

// --------------------
// Slash Commands
// --------------------
app.post("/slack/commands", async (req, res) => {
  const { command, text, user_id, user_name } = req.body;

  // Respond immediately (Slack requires <3s)
  res.send("");

  // /kudos
  if (command === "/kudos") {
    kudos[user_id] = (kudos[user_id] || 0) + 10;

    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      text: `🎉 <@${user_id}> received kudos!\nReason: ${text}\nTotal: ${kudos[user_id]}`
    });
  }

  // /expertise
  if (command === "/expertise") {
    if (!expertise[user_id]) expertise[user_id] = [];

    if (text.startsWith("add")) {
      const skills = text.replace("add", "").split(",").map(s => s.trim());
      expertise[user_id].push(...skills);

      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: `🧠 <@${user_id}> added expertise: ${skills.join(", ")}`
      });
    } else {
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: `🧠 <@${user_id}> expertise: ${(expertise[user_id] || []).join(", ") || "None"}`
      });
    }
  }

  // /leaderboard
  if (command === "/leaderboard") {
    const board = Object.entries(kudos)
      .sort((a, b) => b[1] - a[1])
      .map(([id, points]) => `<@${id}>: ${points}`)
      .join("\n");

    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      text: `🏆 Leaderboard:\n${board || "No kudos yet"}`
    });
  }
});

// --------------------
app.listen(PORT, () => {
  console.log(`🚀 BadgeUp running on port ${PORT}`);
});

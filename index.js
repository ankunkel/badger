const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// In-memory storage
let kudos = {};
let expertise = {};
let badges = {};
let questions = {};
let domains = {}; // dynamic domains
let allBadges = {}; // dynamic badges

// ---------------- Slash Commands ----------------
app.post("/slack/commands", async (req, res) => {
  const { command, text, user_id, trigger_id } = req.body;

  try {
    if (command === "/kudos") {
      if (!text.trim()) return res.send("⚠️ Please provide a reason. Usage: /kudos @user reason");

      kudos[user_id] = (kudos[user_id] || 0) + 5;
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `:tada: Kudos to <@${user_id}>!\n========\nWhy: ${text}\nPoints: 5\nTotal: ${kudos[user_id]} :star2:`
      });

      return res.send("✅ Your kudos was sent!");
    }

    if (command === "/domain") {
      res.send("📝 Opening domain management modal...");
      await axios.post("https://slack.com/api/views.open", {
        trigger_id,
        view: {
          type: "modal",
          callback_id: "domain_modal",
          title: { type: "plain_text", text: "Manage Domains" },
          submit: { type: "plain_text", text: "Save" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "domain_select_block",
              element: {
                type: "external_select",
                action_id: "domain_select",
                placeholder: { type: "plain_text", text: "Select or type a domain" },
                min_query_length: 0
              },
              label: { type: "plain_text", text: "Choose existing domain" }
            },
            {
              type: "input",
              block_id: "domain_text_block",
              element: { type: "plain_text_input", action_id: "domain_text", placeholder: { type: "plain_text", text: "Or add a new domain" } },
              optional: true,
              label: { type: "plain_text", text: "New domain" }
            }
          ]
        }
      }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
      return;
    }

    if (command === "/badge") {
      res.send("📝 Opening badge modal...");
      await axios.post("https://slack.com/api/views.open", {
        trigger_id,
        view: {
          type: "modal",
          callback_id: "badge_modal",
          title: { type: "plain_text", text: "Give Badge" },
          submit: { type: "plain_text", text: "Give" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "badge_user_block",
              element: { type: "users_select", action_id: "badge_user", placeholder: { type: "plain_text", text: "Select a user" } },
              label: { type: "plain_text", text: "User" }
            },
            {
              type: "input",
              block_id: "badge_select_block",
              element: {
                type: "external_select",
                action_id: "badge_select",
                placeholder: { type: "plain_text", text: "Select or type a badge" },
                min_query_length: 0
              },
              label: { type: "plain_text", text: "Choose existing badge" },
              optional: true
            },
            {
              type: "input",
              block_id: "badge_text_block",
              element: { type: "plain_text_input", action_id: "badge_text", placeholder: { type: "plain_text", text: "Or add a new badge" } },
              optional: true,
              label: { type: "plain_text", text: "New badge" }
            }
          ]
        }
      }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
      return;
    }

// -------- /question --------
  if (command === "/question") {
    await axios.post("https://slack.com/api/views.open", {
      trigger_id,
      view: {
        type: "modal",
        callback_id: "question_modal",
        title: { type: "plain_text", text: "Ask a Question" },
        submit: { type: "plain_text", text: "Post" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "domain_block",
            element: {
              type: "external_select",
              action_id: "domain_select",
              placeholder: { type: "plain_text", text: "Select a domain" },
              min_query_length: 0
            },
            label: { type: "plain_text", text: "Domain" }
          },
          {
            type: "input",
            block_id: "question_block",
            element: {
              type: "plain_text_input",
              action_id: "question_text",
              multiline: true,
              placeholder: { type: "plain_text", text: "Write your question here" }
            },
            label: { type: "plain_text", text: "Question" }
          }
        ]
      }
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  }

  // -------- /answer --------
  if (command === "/answer") {
    const [questionId, ...answerParts] = text.split(" ");
    const answerText = answerParts.join(" ");
    const question = questions[questionId];

    if (question && answerText) {
      question.answers.push({ user: user_id, text: answerText });
      await postToSlack([
        { type: "section", text: { type: "mrkdwn", text: `:speech_balloon: <@${user_id}> answered question ${questionId}:\n>${answerText}` } }
      ]);
    }
  }

  // -------- /questions --------
  if (command === "/questions") {
    const domainFilter = text.trim();
    const list = Object.values(questions)
      .filter(q => !domainFilter || q.domain.toLowerCase() === domainFilter.toLowerCase())
      .map(q => `*${q.id}* (${q.domain}) - ${q.text}`);

    await axios.post(SLACK_WEBHOOK_URL, {
      text: list.length ? list.join("\n") : "No questions found."
    });
  }
});

// -------- /question-query --------
if (command === "/question-query") {
  const domainFilter = text.trim().toLowerCase();
  const list = Object.values(questions)
    .filter(q => !domainFilter || q.domain.toLowerCase() === domainFilter)
    .map(q => `*${q.id}* (${q.domain}) - ${q.text}`);

  await axios.post(SLACK_WEBHOOK_URL, {
    text: list.length ? list.join("\n") : "No questions found."
  });
}

// -------- /leaderboard --------
if (command === "/leaderboard") {
  // leaderboard for kudos
  const leaderboard = Object.entries(kudos)
    .sort((a,b) => b[1] - a[1])
    .map(([user, points], i) => `${i+1}. <@${user}> - ${points} points`);

  await axios.post(SLACK_WEBHOOK_URL, {
    text: leaderboard.length ? "*Kudos Leaderboard:*\n" + leaderboard.join("\n") : "No users yet."
  });
}

// -------- /expertise --------
if (command === "/expertise") {
  const args = text.split(" ");
  const action = args[0];
  const domainName = args.slice(1).join(" ");

  if (action === "add" && domainName) {
    expertise[user_id] = expertise[user_id] || [];
    if (!expertise[user_id].includes(domainName)) {
      expertise[user_id].push(domainName);
      domains[domainName] = true;
    }
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `<@${user_id}> added themselves to domain *${domainName}*`
    });
  }

  if (action === "show") {
    const list = (expertise[user_id] || []).map(d => `- ${d}`);
    await axios.post(SLACK_WEBHOOK_URL, {
      text: list.length ? `Your domains:\n${list.join("\n")}` : "You have no domains."
    });
  }
}
  } catch (err) {
    console.error(err);
    res.send("❌ Something went wrong. Try again.");
  }
});

// ---------------- Interactivity ----------------
app.post("/slack/interactivity", async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const { type, user, view } = payload;

  try {
    if (type === "view_submission") {
      const callback_id = view.callback_id;

      if (callback_id === "domain_modal") {
        const domainText = view.state.values.domain_text_block.domain_text.value;
        const selectedDomain = view.state.values.domain_select_block.domain_select.selected_option?.value;
        const finalDomain = domainText || selectedDomain;

        if (!finalDomain) return res.send({ response_action: "errors", errors: { domain_text_block: "Please select or enter a domain" } });

        expertise[user.id] = expertise[user.id] || [];
        if (!expertise[user.id].includes(finalDomain)) expertise[user.id].push(finalDomain);
        domains[finalDomain] = true;

        await axios.post(SLACK_WEBHOOK_URL, {
          text: `:bulb: <@${user.id}> added domain *${finalDomain}*!`
        });

        return res.send({ response_action: "clear" });
      }

      if (callback_id === "badge_modal") {
        const badgeText = view.state.values.badge_text_block.badge_text.value;
        const selectedBadge = view.state.values.badge_select_block.badge_select.selected_option?.value;
        const selectedUser = view.state.values.badge_user_block.badge_user.selected_user;
        const finalBadge = badgeText || selectedBadge;

        if (!finalBadge || !selectedUser) return res.send({ response_action: "errors", errors: { badge_text_block: "Select a badge or create one" } });

        badges[selectedUser] = badges[selectedUser] || [];
        if (!badges[selectedUser].includes(finalBadge)) badges[selectedUser].push(finalBadge);

        await axios.post(SLACK_WEBHOOK_URL, {
          text: `:medal: <@${selectedUser}> received badge *${finalBadge}* from <@${user.id}>!`
        });

        return res.send({ response_action: "clear" });
      }
    }

    // ---------------- Autocomplete suggestions ----------------
    if (type === "block_suggestion") {
      const action_id = payload.action_id;
      const value = payload.value.toLowerCase();

      let options = [];

      if (action_id === "domain_select") {
        options = Object.keys(domains)
          .filter(d => d.toLowerCase().includes(value))
          .map(d => ({ text: { type: "plain_text", text: d }, value: d }));
      }

      if (action_id === "badge_select") {
        options = Object.keys(allBadges)
          .filter(b => b.toLowerCase().includes(value))
          .map(b => ({ text: { type: "plain_text", text: b }, value: b }));
      }

      return res.json({ options });
    }

  } catch (err) {
    console.error(err);
    res.send({ response_action: "errors", errors: { _general: "Something went wrong." } });
  }
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BadgeUp running on port ${PORT}`));

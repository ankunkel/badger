require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cron = require("node-cron");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --------------------- In-memory storage ---------------------
let badges = []; // ["React", "Node.js", "Python"]
let questions = []; // { id, userId, userName, text, badge, timestamp, bestAnswer: null }
let weeklyPoints = {}; // { userId: points }
let lifetimePoints = {}; // { userId: { badge: points } }
let userBadges = {}; // { userId: ["React", "Python"] } - badges earned (50+ lifetime points)

const BADGE_THRESHOLD = 50; // Points needed to earn a badge

// --------------------- Helper Functions ---------------------
async function postToSlack(message, channel) {
  try {
    await axios.post(process.env.SLACK_WEBHOOK_URL, { 
      text: message,
      channel: channel 
    });
  } catch (err) {
    console.error("Error posting to Slack:", err);
  }
}

function getUsersWithBadge(badge) {
  // Returns array of userIds who have earned this badge
  return Object.entries(userBadges)
    .filter(([userId, badges]) => badges.includes(badge))
    .map(([userId]) => userId);
}

function checkAndAwardBadge(userId, badge, lifetimePointsInBadge) {
  // Check if user just earned the badge
  if (!userBadges[userId]) userBadges[userId] = [];
  
  if (lifetimePointsInBadge >= BADGE_THRESHOLD && !userBadges[userId].includes(badge)) {
    userBadges[userId].push(badge);
    return true; // Badge newly earned
  }
  
  return false; // No new badge
}

// --------------------- Scheduled Tasks ---------------------
// Post leaderboard every Monday at 9 AM
cron.schedule("0 9 * * 1", async () => {
  console.log("Running weekly leaderboard post...");
  
  if (Object.keys(weeklyPoints).length === 0) {
    console.log("No activity this week");
    return;
  }
  
  // Sort by weekly points
  const topUsers = Object.entries(weeklyPoints)
    .map(([userId, points]) => ({ userId, points }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
  
  const leaderboard = topUsers
    .map((entry, idx) => `${idx + 1}. <@${entry.userId}>: ${entry.points} pts`)
    .join("\n");
  
  await postToSlack(
    `📊 *Weekly Leaderboard*\n\n${leaderboard}\n\n_Resetting for next week..._`
  );
  
  // Reset weekly points
  weeklyPoints = {};
}, {
  timezone: "America/Phoenix"
});

// --------------------- Slack Commands ---------------------
app.post("/slack/commands", async (req, res) => {
  const { command, text, user_id, user_name, channel_id } = req.body;
  res.send(""); // Must respond within 3s

  try {
    switch (command) {
      // ---------------- /create-badge ----------------
      case "/create-badge": {
        const badgeName = text.trim();
        if (!badgeName) {
          await postToSlack("❌ Please provide a badge name. Usage: `/create-badge [badge name]`");
          break;
        }
        
        if (badges.includes(badgeName)) {
          await postToSlack(`❌ Badge "${badgeName}" already exists.`);
          break;
        }
        
        badges.push(badgeName);
        
        await postToSlack(
          `🎯 *New badge created: ${badgeName}*\n` +
          `Created by: <@${user_id}>\n` +
          `Users will earn this badge by reaching ${BADGE_THRESHOLD} lifetime points.`
        );
        break;
      }

      // ---------------- /list-badges ----------------
      case "/list-badges": {
        if (badges.length === 0) {
          await postToSlack("🏅 No badges created yet. Use `/create-badge [badge name]` to create one.");
          break;
        }
        
        await postToSlack(`🏅 *Available Badges:*\n${badges.map(b => `• ${b}`).join("\n")}`);
        break;
      }

      // ---------------- /delete-badge ----------------
      case "/delete-badge": {
        const badgeName = text.trim();
        if (!badgeName) {
          await postToSlack("❌ Please provide a badge name. Usage: `/delete-badge [badge name]`");
          break;
        }
        
        const index = badges.indexOf(badgeName);
        if (index === -1) {
          await postToSlack(`❌ Badge "${badgeName}" doesn't exist.`);
          break;
        }
        
        badges.splice(index, 1);
        
        // Remove from user badges
        Object.keys(userBadges).forEach(userId => {
          userBadges[userId] = userBadges[userId].filter(b => b !== badgeName);
        });
        
        await postToSlack(
          `🗑️ Badge *${badgeName}* has been deleted by <@${user_id}>.`
        );
        break;
      }

      // ---------------- /ask ----------------
      case "/ask": {
        // Format: /ask [badge] [question text]
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
          await postToSlack("❌ Usage: `/ask [badge] [question]`");
          break;
        }
        
        const badge = parts[0];
        const questionText = parts.slice(1).join(" ");
        
        if (!badges.includes(badge)) {
          await postToSlack(`❌ Badge "${badge}" doesn't exist. Create it first with \`/create-badge ${badge}\``);
          break;
        }
        
        const questionId = questions.length + 1;
        questions.push({
          id: questionId,
          userId: user_id,
          userName: user_name,
          text: questionText,
          badge: badge,
          timestamp: Date.now(),
          bestAnswer: null
        });
        
        // Get all users with this badge
        const experts = getUsersWithBadge(badge);
        const expertTags = experts.length > 0 
          ? experts.map(id => `<@${id}>`).join(" ")
          : "_No experts with this badge yet_";
        
        await postToSlack(
          `❓ *New Question [#${questionId}]*\n` +
          `Badge: *${badge}*\n` +
          `Asked by: <@${user_id}>\n` +
          `Question: ${questionText}\n\n` +
          `📢 Tagging experts: ${expertTags}`
        );
        break;
      }

      // ---------------- /find-experts ----------------
      case "/find-experts": {
        const badgeName = text.trim();
        
        if (!badgeName) {
          await postToSlack("❌ Please specify a badge. Usage: `/find-experts [badge name]`");
          break;
        }
        
        if (!badges.includes(badgeName)) {
          await postToSlack(`❌ Badge "${badgeName}" doesn't exist.`);
          break;
        }
        
        const experts = getUsersWithBadge(badgeName);
        
        if (experts.length === 0) {
          await postToSlack(`📋 No one has earned the *${badgeName}* badge yet (need ${BADGE_THRESHOLD} lifetime points).`);
          break;
        }
        
        // Show experts with their lifetime points in this badge
        const expertList = experts.map(userId => {
          const points = lifetimePoints[userId]?.[badgeName] || 0;
          return `<@${userId}>: ${points} lifetime pts`;
        }).join("\n");
        
        await postToSlack(
          `👥 *Experts with ${badgeName} badge:*\n${expertList}\n\n` +
          `These users have earned ${BADGE_THRESHOLD}+ lifetime points in ${badgeName}.`
        );
        break;
      }

      // ---------------- /best-answer ----------------
      case "/best-answer": {
        // Format: /best-answer [question-id] @user [optional: points]
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
          await postToSlack("❌ Usage: `/best-answer [question-id] @user [optional: points]`");
          break;
        }
        
        const questionId = parseInt(parts[0]);
        const userMatch = parts[1].match(/<@([A-Z0-9]+)(\|[^>]+)?>/);
        const points = parts[2] ? parseInt(parts[2]) : 5; // Default to 5 points
        
        if (!userMatch || isNaN(points) || points <= 0) {
          await postToSlack("❌ Invalid format. Usage: `/best-answer [question-id] @user [optional: points]`");
          break;
        }
        
        const answererUserId = userMatch[1];
        const question = questions.find(q => q.id === questionId);
        
        if (!question) {
          await postToSlack(`❌ Question #${questionId} not found.`);
          break;
        }
        
        if (question.userId !== user_id) {
          await postToSlack(`❌ Only <@${question.userId}> (the question asker) can mark the best answer.`);
          break;
        }
        
        if (question.bestAnswer) {
          await postToSlack(`❌ Question #${questionId} already has a best answer.`);
          break;
        }
        
        // Award points
        question.bestAnswer = { userId: answererUserId, points: points };
        
        // Update weekly points
        weeklyPoints[answererUserId] = (weeklyPoints[answererUserId] || 0) + points;
        
        // Update lifetime points for the badge
        if (!lifetimePoints[answererUserId]) lifetimePoints[answererUserId] = {};
        if (!lifetimePoints[answererUserId][question.badge]) {
          lifetimePoints[answererUserId][question.badge] = 0;
        }
        lifetimePoints[answererUserId][question.badge] += points;
        
        const lifetimePointsInBadge = lifetimePoints[answererUserId][question.badge];
        
        // Check if user earned the badge
        const badgeEarned = checkAndAwardBadge(answererUserId, question.badge, lifetimePointsInBadge);
        
        let message = 
          `🏆 *Best Answer Awarded!*\n` +
          `Question #${questionId}: "${question.text}"\n` +
          `Badge: *${question.badge}*\n` +
          `Winner: <@${answererUserId}>\n` +
          `Points: *+${points} pts*\n` +
          `Weekly total: ${weeklyPoints[answererUserId]} pts\n` +
          `Lifetime in ${question.badge}: ${lifetimePointsInBadge} pts`;
        
        if (badgeEarned) {
          message += `\n\n🎉 *BADGE EARNED!* 🎉\n<@${answererUserId}> earned the *${question.badge}* badge!`;
        }
        
        await postToSlack(message);
        break;
      }

      // ---------------- /leaderboard ----------------
      case "/leaderboard": {
        if (Object.keys(weeklyPoints).length === 0) {
          await postToSlack("📊 No points awarded this week yet.");
          break;
        }
        
        const topUsers = Object.entries(weeklyPoints)
          .map(([userId, points]) => ({ userId, points }))
          .sort((a, b) => b.points - a.points)
          .slice(0, 10);
        
        const leaderboard = topUsers
          .map((entry, idx) => `${idx + 1}. <@${entry.userId}>: ${entry.points} pts`)
          .join("\n");
        
        await postToSlack(
          `📊 *Weekly Leaderboard*\n\n${leaderboard}`
        );
        break;
      }

      // ---------------- /my-badges ----------------
      case "/my-badges": {
        const myBadges = userBadges[user_id] || [];
        
        if (myBadges.length === 0) {
          await postToSlack(
            `You haven't earned any badges yet.\n` +
            `Answer questions to earn ${BADGE_THRESHOLD} lifetime points in a badge area!`
          );
          break;
        }
        
        const badgeList = myBadges.map(badge => {
          const points = lifetimePoints[user_id]?.[badge] || 0;
          return `🏅 *${badge}* (${points} lifetime pts)`;
        }).join("\n");
        
        const weeklyPts = weeklyPoints[user_id] || 0;
        
        await postToSlack(
          `*Your Badges:*\n${badgeList}\n\n` +
          `Weekly points: ${weeklyPts}`
        );
        break;
      }

      // ---------------- /my-stats ----------------
      case "/my-stats": {
        const myBadges = userBadges[user_id] || [];
        const myLifetimePoints = lifetimePoints[user_id] || {};
        const myWeeklyPoints = weeklyPoints[user_id] || 0;
        
        let stats = `📊 *Your Stats*\n\n`;
        stats += `Weekly points: ${myWeeklyPoints}\n`;
        stats += `Badges earned: ${myBadges.length}\n\n`;
        
        if (Object.keys(myLifetimePoints).length > 0) {
          stats += `*Lifetime Points by Badge:*\n`;
          Object.entries(myLifetimePoints)
            .sort((a, b) => b[1] - a[1])
            .forEach(([badge, points]) => {
              const hasBadge = myBadges.includes(badge);
              const icon = hasBadge ? "🏅" : "⏳";
              stats += `${icon} ${badge}: ${points} pts${!hasBadge ? ` (${BADGE_THRESHOLD - points} more for badge)` : ""}\n`;
            });
        } else {
          stats += `No lifetime points yet. Start answering questions!`;
        }
        
        await postToSlack(stats);
        break;
      }

      default:
        await postToSlack(`❌ Unknown command: ${command}`);
    }
  } catch (err) {
    console.error("Error handling command:", err);
    await postToSlack(`❌ Error processing command ${command}: ${err.message}`);
  }
});

// --------------------- Health Check ---------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// --------------------- Start Server ---------------------
app.listen(PORT, () => {
  console.log(`🚀 Slack Badge App running on port ${PORT}`);
  console.log(`📅 Weekly leaderboard scheduled for Mondays at 9 AM (Phoenix time)`);
});

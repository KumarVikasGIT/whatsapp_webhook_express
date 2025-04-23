const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const token = process.env.TOKEN;
const verifyToken = process.env.MYTOKEN;
const pattern = /^SRVZ-ORD-\d{6}$/;

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Webhook server is listening on port ${PORT}`);
});

// Verify the webhook setup (for Facebook/Meta Cloud API)
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const token = req.query["hub.verify_token"];

    if (mode && token) {
        if (mode === "subscribe" && token === verifyToken) {
            console.log("Webhook verified successfully.");
            return res.status(200).send(challenge);
        } else {
            console.warn("Webhook verification failed: Token mismatch");
            return res.sendStatus(403);
        }
    }
    res.sendStatus(403);
});

// Handle incoming messages
app.post("/webhook", async (req, res) => {
    const body = req.body;
    console.log("📩 Received webhook event:");

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const metadata = body.entry?.[0]?.changes?.[0]?.value?.metadata;
    const contact = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];

    if (!body.object || !message || !metadata || !contact) {
        console.warn("⚠️ Invalid webhook structure");
        return res.sendStatus(404);
    }

    const phoneNumberId = metadata.phone_number_id;
    const sender = message.from;
    const text = message.text?.body?.trim() || "";
    const lowerText = text.toLowerCase();
    const senderName = contact.profile?.name || "Unknown";

    console.log("📞 Phone number ID:", phoneNumberId);
    console.log("👤 Sender:", sender);
    console.log("🧾 Message body:", text);
    console.log("📛 Sender name:", senderName);

    // RegEx pattern for Order ID
    const orderPattern = /^SRVZ-ORD-\d{6}$/i;

    try {
        if (lowerText === "hello") {
            // 🔹 Send template message if user says "hello"
            const templateResponse = await axios.post(
                `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
                {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: sender,
                    type: "template",
                    template: {
                        name: "test1",
                        language: { code: "en_US" },
                        components: [
                            {
                                type: "body",
                                parameters: [
                                    {
                                        type: "text",
                                        text: senderName
                                    }
                                ]
                            }
                        ]
                    }
                },
                {
                    headers: { "Content-Type": "application/json" }
                }
            );

            console.log("✅ Template message sent:", templateResponse.data);
            return res.sendStatus(200);
        }

        if (orderPattern.test(text)) {
            // 🔹 Handle order ID messages
            const orderResponse = await axios.post(
                `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
                {
                    messaging_product: "whatsapp",
                    to: sender,
                    text: {
                        body: `📦 Order Details\n🆔 Order ID: ${text}\n\nPlease choose an option to continue.`
                    }
                },
                {
                    headers: { "Content-Type": "application/json" }
                }
            );

            console.log("✅ Order message sent:", orderResponse.data);
            return res.sendStatus(200);
        }

        // 🔹 Fallback message for any other input
        const fallbackResponse = await axios.post(
            `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
            {
                messaging_product: "whatsapp",
                to: sender,
                text: {
                    body: `👋 Hi ${senderName}, you currently have 6 jobs pending.\nPlease enter a valid order ID (e.g., SRVZ-ORD-123456) to view details.\n\nThank you!`
                }
            },
            {
                headers: { "Content-Type": "application/json" }
            }
        );

        console.log("✅ Fallback message sent:", fallbackResponse.data);
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error.message);
        res.sendStatus(500);
    }
});


// Default route
app.get("/", (req, res) => {
    res.status(200).send("Hello, this is the WhatsApp webhook setup!");
});
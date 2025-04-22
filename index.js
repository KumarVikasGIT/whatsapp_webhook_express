const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const token = process.env.TOKEN;
const verifyToken = process.env.MYTOKEN;

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

    if (body.object && message && metadata && contact) {
        const phoneNumberId = metadata.phone_number_id;
        const sender = message.from;
        const text = message.text?.body || "";
        const senderName = contact.profile?.name || "Unknown";

        console.log("📞 Phone number ID:", phoneNumberId);
        console.log("👤 Sender:", sender);
        console.log("🧾 Message body:", text);
        console.log("📛 Sender name:", senderName);

        try {
            // Send template reply if message is "hello"
            if (text.toLowerCase() === "hello") {
                const templateResponse = await axios.post(
                    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
                    {
                        messaging_product: "whatsapp",
                        recipient_type: "individual",
                        to: sender,
                        type: "template",
                        template: {
                            name: "test1",
                            language: {
                                code: "en_US"
                            },
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
                        headers: {
                            "Content-Type": "application/json"
                        }
                    }
                );
                res.sendStatus(200);
                console.log("✅ Template message sent:", templateResponse.data);
            }

            // Send fallback/default text message
            const textResponse = await axios.post(
                `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
                {
                    messaging_product: "whatsapp",
                    to: sender,
                    text: {
                        body: `Hi.. I'm Vikas, your message is: "${text}"`
                    }
                },
                {
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );

            console.log("✅ Text message sent:", textResponse.data);
            res.sendStatus(200);
        } catch (error) {
            console.error("❌ Error sending message:", error.response?.data || error.message);
            res.sendStatus(500);
        }
    } else {
        console.warn("⚠️ No valid message found in webhook event");
        res.sendStatus(404);
    }
});


// Default route
app.get("/", (req, res) => {
    res.status(200).send("Hello, this is the WhatsApp webhook setup!");
});
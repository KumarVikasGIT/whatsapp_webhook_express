import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const payload = {
  app: 'WhatsApp-Bot',
};

// Make sure JWT_SECRET is defined in your `.env` file
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not defined in environment variables');
}

export var JWT_TOKEN = jwt.sign({
  app: 'WhatsApp-Bot',
}, process.env.JWT_SECRET, {
  expiresIn: '5m',
});

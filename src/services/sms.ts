/**
 * SMS Service using Twilio
 * Sends SMS messages to patients
 */

import twilio from "twilio";
import { config } from "../config/index.js";

export interface SMSOptions {
  to: string; // Patient's phone number (caller's number)
  body: string;
}

export class SMSService {
  private client: twilio.Twilio | null = null;

  constructor() {
    // Use central config (which already checks .env and process.env)
    const accountSid = config.twilio.accountSid;
    const authToken = config.twilio.authToken;

    console.log("CHECK REDA accountSid", accountSid);
    console.log("CHECK REDAauthToken", authToken);

    // Check if values are non-empty strings
    if (accountSid && authToken) {
      this.client = twilio(accountSid, authToken);
      console.log("✅ Twilio SMS client initialized");
    } else {
      console.warn(
        "⚠️ Twilio credentials not configured. SMS sending will be disabled."
      );
      console.warn(`   TWILIO_ACCOUNT_SID: ${accountSid ? "set" : "missing"}`);
      console.warn(`   TWILIO_AUTH_TOKEN: ${authToken ? "set" : "missing"}`);
    }
  }

  /**
   * Send SMS to patient
   */
  async sendSMS(
    options: SMSOptions
  ): Promise<{ success: boolean; messageSid?: string; error?: string }> {
    if (!this.client) {
      return {
        success: false,
        error:
          "Twilio client not initialized. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
      };
    }

    // Use central config (which already checks .env and process.env)
    const from = config.twilio.phoneNumber;
    if (!from || from.trim() === "") {
      return {
        success: false,
        error: "TWILIO_PHONE_NUMBER not configured in config.",
      };
    }

    try {
      const message = await this.client.messages.create({
        body: options.body,
        to: options.to,
        from: from,
      });

      console.log(`✅ SMS sent to ${options.to}: ${message.sid}`);
      return {
        success: true,
        messageSid: message.sid,
      };
    } catch (error: any) {
      console.error(`❌ Failed to send SMS to ${options.to}:`, error.message);
      return {
        success: false,
        error: error.message || "Unknown error",
      };
    }
  }

  /**
   * Send doctor availability confirmation SMS
   */
  async sendAvailabilityConfirmation(
    patientPhone: string,
    doctorName: string,
    dateTime: string,
    available: boolean
  ): Promise<{ success: boolean; messageSid?: string; error?: string }> {
    const date = new Date(dateTime);
    const formattedDate = date.toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    let body: string;
    if (available) {
      body = `✅ Appointment Confirmed!\n\nYour appointment with ${doctorName} is confirmed for ${formattedDate}.\n\nThank you for choosing our service!`;
    } else {
      body = `❌ Appointment Unavailable\n\nSorry, ${doctorName} is not available at ${formattedDate}. Please choose another time.`;
    }

    return this.sendSMS({
      to: patientPhone,
      body,
    });
  }
}

// Global SMS service instance
export const smsService = new SMSService();

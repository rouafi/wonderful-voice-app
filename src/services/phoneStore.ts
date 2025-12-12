/**
 * Simple in-memory store for call SID to phone number mapping
 * Used to retrieve patient phone number for SMS sending
 */

class PhoneStore {
  private callToPhone: Map<string, string> = new Map();

  /**
   * Store phone number for a call
   */
  setPhone(callSid: string, phoneNumber: string): void {
    this.callToPhone.set(callSid, phoneNumber);
    console.log(`📱 Stored phone ${phoneNumber} for call ${callSid.substring(0, 8)}`);
  }

  /**
   * Get phone number for a call
   */
  getPhone(callSid: string): string | undefined {
    return this.callToPhone.get(callSid);
  }

  /**
   * Remove phone number for ended call
   */
  remove(callSid: string): void {
    this.callToPhone.delete(callSid);
  }
}

export const phoneStore = new PhoneStore();


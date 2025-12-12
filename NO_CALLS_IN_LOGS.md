# Troubleshooting: Calls Not Appearing in Twilio Logs

## If calls don't show in Twilio Monitor → Logs → Calls

This means the calls aren't reaching Twilio at all. Here's how to fix it:

## 1. Check Trial Account Restrictions ⚠️

**Most Common Issue:** Twilio trial accounts can ONLY receive calls from **verified phone numbers**.

### Verify Your Calling Number:
1. Go to **Twilio Console** → **Phone Numbers** → **Manage** → **Verified Caller IDs**
2. Add your phone number if it's not there
3. Twilio will send a verification code
4. Enter the code to verify

**After verification, try calling again.**

## 2. Check Phone Number Configuration

In **Twilio Console** → **Phone Numbers** → **Manage** → **Active Numbers**:

- ✅ Click on your Twilio phone number
- ✅ Under **Voice & Fax**:
  - **A CALL COMES IN**: Should be your webhook URL
  - **HTTP**: Should be **POST**
  - **STATUS CALLBACK URL**: Optional but helpful

## 3. Test with TwiML Bin (Bypass Your Server)

To verify the phone number works:

1. Go to **Runtime** → **TwiML Bins**
2. Create a new TwiML Bin:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <Response>
     <Say>Hello, this is a test call.</Say>
   </Response>
   ```
3. Go to **Phone Numbers** → Your Number
4. Set **A CALL COMES IN** to the TwiML Bin
5. Call your number
6. If you hear "Hello, this is a test call", the number works

## 4. Check Account Status

- Go to **Console** → **Account** → **General**
- Verify account is **Active** (not suspended)
- Check if you're on a **Trial** account

## 5. Verify You're Calling the Right Number

- Double-check the Twilio phone number
- Make sure you're calling from a **verified number** (if on trial)
- Try calling from a different verified number

## 6. Check for Account Warnings

- Go to **Console** → **Monitor** → **Logs** → **Errors**
- Look for any account-related errors
- Check for suspension or restriction messages

## Quick Test Checklist

- [ ] Your calling number is verified in Twilio
- [ ] Phone number webhook is configured
- [ ] Account is active (not suspended)
- [ ] You're calling the correct Twilio number
- [ ] TwiML Bin test works (if not, number might be blocked)

## Most Likely Solution

**If you're on a trial account:** Verify your phone number first, then try calling again.


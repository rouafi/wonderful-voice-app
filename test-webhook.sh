#!/bin/bash

# Test script for Twilio webhook endpoint
# Usage: ./test-webhook.sh

ENDPOINT="${1:-http://localhost:3000/incoming-call}"

echo "🧪 Testing Twilio webhook endpoint: $ENDPOINT"
echo ""

curl -X POST "$ENDPOINT" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA1234567890abcdef" \
  -d "AccountSid=AC1234567890abcdef" \
  -d "From=%2B1234567890" \
  -d "To=%2B0987654321" \
  -d "CallStatus=ringing" \
  -d "Direction=inbound" \
  -v

echo ""
echo ""
echo "✅ Check the response above for valid TwiML XML"


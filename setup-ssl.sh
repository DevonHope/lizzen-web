#!/bin/bash
# Quick script to test DNS and get SSL when ready

echo "🔍 Checking DNS propagation for lizzen.org..."

# Check main domain
IP=$(dig lizzen.org +short @8.8.8.8)
if [ "$IP" = "209.74.95.160" ]; then
    echo "✅ lizzen.org points to correct IP: $IP"
    
    # Get SSL certificate
    echo "🔒 Getting SSL certificate..."
    sudo certbot --nginx -d lizzen.org -d www.lizzen.org --non-interactive --agree-tos --email contact@lizzen.org
    
    if [ $? -eq 0 ]; then
        echo "🎉 SSL certificate installed successfully!"
        echo "🌐 Your site should now be available at: https://lizzen.org"
    else
        echo "❌ SSL certificate installation failed"
    fi
else
    echo "⏳ DNS not propagated yet. Current IP: $IP"
    echo "Expected: 209.74.95.160"
    echo "Try again in 15-30 minutes"
fi

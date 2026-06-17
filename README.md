# 🎭 Guess Who — Multiplayer

## Setup

1. Make sure you have **Node.js** installed (https://nodejs.org)
2. Open a terminal in this folder
3. Run:

```
npm install
node server.js
```

4. The server will print something like:
   ```
   🎭 Guess Who server running!
      Open http://localhost:3000 on both laptops
   ```

5. **Both laptops must be on the same Wi-Fi network.**
   - On the host laptop, find your local IP address:
     - Windows: run `ipconfig` → look for IPv4 Address (e.g. 192.168.1.42)
     - Mac/Linux: run `ifconfig` or `ip addr` → look for inet address
   - On the second laptop, open a browser and go to: `http://192.168.1.42:3000` (use your actual IP)
   - On the host laptop, go to: `http://localhost:3000`

---

## How to Play

1. **Upload photos (Admin only)**
   - Click **⚙ Admin** in the top right
   - Upload 2–25 photos of your friends
   - Password: `admin123`
   - Click **Push Photos to Game** — both screens update instantly

2. **Both players enter their names and join**

3. **Pick your secret character**
   - Each player secretly taps who they want to be
   - Click **Lock In My Choice**
   - Once both have picked, the game starts!

4. **Take turns**
   - The player whose turn it is asks their opponent a yes/no question out loud
   - Tap cards on your board to flip them face-down and eliminate people
   - When ready, hit **End Turn** to pass to the other player
   - When you think you know — hit **🎯 Guess!**

---

## Admin Password
Default: `admin123`

To change it, open `server.js` and edit this line:
```js
adminPassword: 'admin123',
```

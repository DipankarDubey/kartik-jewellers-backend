# Cloud setup — Karthik Jewellers

## Current setup status (verified 2026-11-14)

- **Cloudinary:** Connected Free-plan environment. Created the `karthik-jewellers` Media Library folder. The authenticated `POST /api/admin/upload` endpoint uploads images to that folder.
- **MongoDB Atlas:** AI client access is enabled. Connected to the existing `NodePractice` FREE cluster (Project 0, AWS Mumbai / `AP_SOUTH_1`). Created and verified database `kartik_jewellers` with collections `admins`, `products`, `customers`. No production admin account or jewellery data was inserted; the Node.js seed process creates the initial admin and six demo products when first launched with valid private credentials.

## MongoDB — existing NodePractice cluster

1. Existing project: **Project 0**; existing FREE cluster: **NodePractice**; database **`kartik_jewellers`** already created with `admins`, `products`, `customers`. Do not recreate them.
2. Under **Database Access**, create a dedicated application user with **readWrite only on `kartik_jewellers`**. Generate a random password and keep it in a private password manager / .env, not GitHub. Existing Atlas users have broad privileges and should not be reused for this app.
3. Under **Network Access**, restrict access to your backend's outgoing IP where possible. **Security review required:** the current Atlas project access list includes `0.0.0.0/0` (all IPv4 addresses); remove it after ensuring necessary application IPs are allowlisted.
4. **Connect** > **Drivers** > **Node.js** on NodePractice. The verified SRV host is `nodepractice.bpsc6bg.mongodb.net`. Set the **private** `MONGODB_URI` to `mongodb+srv://USERNAME:URL_ENCODED_PASSWORD@nodepractice.bpsc6bg.mongodb.net/kartik_jewellers?retryWrites=true&w=majority`. Percent-encode special characters in the database password. The Atlas connector does not reveal a user's password, so this URI is a safe template, not a working credential.

## Cloudinary — existing connected environment

1. In https://console.cloudinary.com/ find **Cloud name** under the product environment / dashboard and **API Key** and **API Secret** under API Keys.
2. Set these three values **only** in the backend's private .env or hosting provider's encrypted environment settings:
   - `CLOUDINARY_CLOUD_NAME=...`
   - `CLOUDINARY_API_KEY=...`
   - `CLOUDINARY_API_SECRET=...`
3. The Cloudinary folder `karthik-jewellers` is already created. The backend uses signed server-side uploads, so no unsigned upload preset is required.
4. Do not expose `CLOUDINARY_API_SECRET` in React or commit it to GitHub.

## Local backend

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm install
npm run dev
```

Set `JWT_SECRET` to the generated random string, and configure private `ADMIN_USERNAME` and a **new** strong `ADMIN_PASSWORD` before starting. The backend automatically initializes its admin record and six sample jewellery products on first boot when connected to MongoDB. Do not reuse an admin password already shared in chat.

**Verification:** `GET http://localhost:5000/api/health` and `GET http://localhost:5000/api/products`. Uploading images additionally requires Cloudinary credentials.

**Security:** `.env` is excluded by `.gitignore`; commit `.env.example` as a template only. SMTP email sending is a separate, optional setup.

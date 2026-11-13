# Cloud setup — Karthik Jewellers

## Current setup status (2026-11-14)

- **Cloudinary:** Connected Free-plan environment. Created the `karthik-jewellers` Media Library folder. The authenticated `POST /api/admin/upload` endpoint uploads images to that folder.
- **MongoDB Atlas:** Organization-level **AI client/MCP access is disabled**. The connected integration cannot inspect the existing `NodePractice` cluster or create a database until the Atlas Organization Owner enables AI client access. **The database has NOT been created or verified yet.**

## MongoDB — existing NodePractice cluster

1. Sign in at https://cloud.mongodb.com/ and locate the project containing the existing **NodePractice** cluster. Do **not** create another cluster.
2. Ask an Atlas **Organization Owner** to enable AI client access (MCP) for the organization if you want the connected assistant to create/verify the database. Otherwise, you can create the database directly in Atlas under NodePractice: **Browse Collections** > **Add My Own Data** > database `kartik_jewellers` > first collection `products`. Other collections (`admins`, `customers`) will be created automatically when the backend writes to them.
3. Under **Database Access**, create a dedicated application user with `readWrite` permissions on `kartik_jewellers`. Generate a random password and store it in your private .env, not GitHub.
4. Under **Network Access**, allow your backend's outgoing IP (and your own current IP for local testing) rather than opening access to the internet when possible.
5. **Connect** > **Drivers** > **Node.js** on NodePractice, copy the SRV URI and set the **private** `MONGODB_URI` to `mongodb+srv://USERNAME:URL_ENCODED_PASSWORD@YOUR_NODEPRACTICE_HOST/kartik_jewellers?retryWrites=true&w=majority`. Percent-encode special characters in the database password.

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

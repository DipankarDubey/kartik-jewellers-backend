# Karthik Jewellers — Express API

Node.js 20+, Express, MongoDB Atlas, Cloudinary, Nodemailer, bcrypt and JWT. No payment checkout is included: the public website is an in-store jewellery catalogue.

## Setup

1. Create a free **MongoDB Atlas M0** cluster, database user, and an appropriately restricted IP access rule. Copy its URI to `MONGODB_URI`.
2. Create a free Cloudinary account for catalogue image uploads. Set the three Cloudinary variables.
3. `cp .env.example .env` and fill in all required variables. Generate JWT secret using `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
4. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` privately in `.env` (never commit it). The first boot creates the password hash; restarting won't overwrite an existing password. To rotate, update the stored hash or provide a dedicated password-reset flow.
5. `npm install && npm run dev` (API on http://localhost:5000).
6. For contact and bulk promotional email, supply SMTP settings and `STORE_EMAIL`. Use a verified sending domain and your provider's compliant mail limits.
7. Set `FRONTEND_URL`, `PUBLIC_BASE_URL`, phone, address and Google Maps URL for production.

## Endpoints

| Public | Admin (Bearer JWT) |
|---|---|
| `GET /api/products` | `GET /api/admin/products` |
| `GET /api/store` | `POST /api/admin/products` |
| `POST /api/contact` | `PUT /api/admin/products/:id` |
| `POST /api/admin/login` | `DELETE /api/admin/products/:id` |
| `GET /api/unsubscribe/:token` | `POST /api/admin/upload` (multipart `image`) |
| `GET /api/health` | `GET/POST /api/admin/customers` |
| | `GET /api/admin/stats` |
| | `POST /api/admin/campaigns/send` |

Six sample products are seeded only on the first admin initialization when the products collection is empty. Deleting them later will not recreate them on restart. Promotional sends only target customers with explicitly checked marketing consent and an active unsubscribe link. Store visit records should only be collected with a suitable privacy notice and permission. Mail dispatch is synchronous in this starter; for production add a queue, delivery logs, retries, and stronger consent auditing. Set appropriate indexes, monitoring, and backup policies before launch.

## Deployment

Deploy as a Node.js service to a hosting provider. Configure variables there, add your domain to CORS via `FRONTEND_URL`, and keep credentials and MongoDB access outside GitHub. Free-tier services can suspend or change limits: verify current tiers with the providers.


## Admin store settings, media and campaign integration

- GET /api/store returns the shop and saved Cloudinary logo/favicon URLs. Authenticated PUT /api/admin/store updates address, Maps URL, contact info, logo and favicon in MongoDB.
- Products use metal=Gold or Silver; the public API can filter with ?metal=Silver. Legacy unclassified products are treated as Gold.
- POST /api/admin/upload receives original JPG/PNG/WebP photos up to 12 MB, preserving original pixels in Cloudinary. Frontend uses f_auto,q_95,c_limit,w_1000 delivery transforms, which do not upscale small originals.
- SMTP email campaigns accept posterUrl pointing to a secure Cloudinary image and attach the image to each message to opted-in customers.
- WhatsApp campaign sending requires separately recorded WhatsApp consent plus an approved WhatsApp Business message template with IMAGE header.
- Configure WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE_NAME and optionally WHATSAPP_TEMPLATE_LANGUAGE=en, WHATSAPP_GRAPH_API_VERSION=v24.0 in private backend environment settings. Configure Meta business account and obtain template approval first.
- Optional STORE_LOGO_URL and STORE_FAVICON_URL define branding before the admin sets them in MongoDB. PUBLIC_BASE_URL must be the deployed backend root for unsubscribe links.
- Deployment order: backend first, then frontend; verify login, product CRUD, store settings, media upload and both campaign types on staging before production release.

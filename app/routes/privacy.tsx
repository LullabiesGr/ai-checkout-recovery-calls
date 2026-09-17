import { PublicPage } from "../components/PublicPage";
export const meta=()=>[{title:"CartEcho Privacy Policy"}];
export default function PrivacyPolicy(){return <PublicPage title="Privacy policy">
  <p>Effective 12 September 2026. This policy describes how CartEcho handles information when a merchant installs and uses the app.</p>
  <h2>Who handles the information</h2>
  <p>CartEcho processes shopper information on the merchant’s instructions to provide abandoned-checkout recovery. The merchant controls whether and how shoppers may be contacted. CartEcho also handles merchant support, security and billing records needed to operate the service. Contact the CartEcho team through our <a href="/support">support form</a> for privacy questions.</p>
  <h2>Information we process</h2>
  <p>Store domain and installation permissions; checkout and order identifiers, items, values and status; shopper names, email addresses and telephone numbers supplied by the store; call attempts, transcripts, recordings where enabled, AI-generated summaries and recovery outcomes; SMS content and delivery identifiers; subscription and extra-attempt purchase records; and messages submitted to support.</p>
  <p>Shopify handles app payments. CartEcho does not receive payment-card numbers. Installation tokens are stored server-side and are not exposed to other merchants or included in customer exports.</p>
  <h2>Why we use information</h2>
  <p>To identify eligible abandoned checkouts, carry out merchant-authorized recovery calls and SMS, create configured discount offers, match resulting orders, show reports, manage attempt balances, answer support requests and protect the app. CartEcho does not sell personal information or use one merchant’s customer records to market another merchant’s products.</p>
  <h2>Service providers</h2>
  <p>Shopify provides commerce and billing services; Render hosts the app; PostgreSQL/Supabase stores application data and supports reporting and support; Vapi and its configured speech and telephony providers process calls; OpenAI processes conversation analysis; and Apifon processes SMS messages. Data is shared only as needed for these services and can be processed outside your country, subject to the applicable provider agreements and safeguards.</p>
  <h2>Retention and deletion</h2>
  <p>Operational data is retained while needed to provide the merchant’s service and is processed for deletion when Shopify sends a verified customer or store erasure request. Uninstalling stops scheduled recovery activity and removes installation sessions. Store erasure is handled following Shopify’s store-deletion notification. Records that must legally be retained are handled separately.</p>
  <p>Customer exports are accessible only inside the authenticated app and expire after 30 days. Minimal hashed identifiers may be retained for 30 days to prevent delayed events from recreating erased records. Deletion from external processors, operational logs and backups may follow their retention procedures; unresolved processor deletion tasks remain open for review.</p>
  <h2>Your rights and choices</h2>
  <p>Shoppers can contact the merchant to request access, correction or deletion of their data, or to stop recovery contact. Shopify’s privacy requests are supported by the app. Merchants can use Privacy requests inside CartEcho and can contact <a href="/support">CartEcho support</a> for assistance. Depending on your location, you may also have rights to restrict or object to processing, obtain portable data or complain to your data-protection authority.</p>
  <h2>Merchant responsibilities and security</h2>
  <p>Merchants must establish the required permission to contact shoppers, honor opt-out requests and provide applicable notices for automated calls, messages and recording. CartEcho uses Shopify authentication, shop-scoped access and verified webhook signatures. Support forms should not contain passwords, access tokens or payment-card details.</p>
  <h2>Policy updates</h2><p>Changes will be published on this page with an updated effective date.</p>
</PublicPage>;}

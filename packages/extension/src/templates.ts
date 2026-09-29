// Starting points for Full mode, by type of app. They pre-fill the setup form; everything is editable.

export interface AppTemplate {
  id: string;
  label: string;
  description: string;
  focusAreas: string[];
  outOfScope: string[];
}

export const TEMPLATES: AppTemplate[] = [
  {
    id: "ecommerce",
    label: "Online shop",
    description:
      "An online shop. Customers browse and search products, add them to a basket, and check out. Prices, quantities, discounts and totals must always agree across the product page, basket and checkout.",
    focusAreas: ["Basket totals, quantities and discounts", "Checkout form validation", "Search, filters and sorting", "Product pages on a phone"],
    outOfScope: ["Completing a real payment"],
  },
  {
    id: "saas",
    label: "SaaS dashboard",
    description:
      "A logged-in web application. Users create, edit and delete records, filter and search lists, and change settings. Changes must be saved and shown consistently everywhere the data appears.",
    focusAreas: ["Create, edit and delete flows", "Form validation and error messages", "Lists: filtering, sorting and paging", "Settings and permissions"],
    outOfScope: ["Billing and subscription changes", "Deleting the test account"],
  },
  {
    id: "marketing",
    label: "Marketing site",
    description:
      "A public marketing website with information pages, a pricing page and contact or sign-up forms. Content should be accurate and consistent, links should work, and forms should validate input and confirm submission.",
    focusAreas: ["Navigation and broken links", "Contact and sign-up forms", "Layout on phone and tablet widths", "Pricing and plan details"],
    outOfScope: [],
  },
];

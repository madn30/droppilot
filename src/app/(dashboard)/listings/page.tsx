import { redirect } from "next/navigation";

export default function ListingsRedirect(): never {
  redirect("/products");
}

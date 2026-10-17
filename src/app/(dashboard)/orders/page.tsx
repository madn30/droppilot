import { redirect } from "next/navigation";

export default function OrdersRedirect(): never {
  redirect("/products");
}

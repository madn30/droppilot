import { redirect } from "next/navigation";

export default function MatchesRedirect(): never {
  redirect("/products");
}

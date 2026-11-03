import Shell from "@/components/shell";
import Workspace from "@/components/workspace";
import { catalogSummary, listCategories } from "@/lib/catalog";

export default function HomePage() {
  return (
    <Shell>
      <Workspace categories={listCategories()} catalog={catalogSummary()} />
    </Shell>
  );
}

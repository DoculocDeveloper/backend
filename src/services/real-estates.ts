import { api } from "./api";
import type { RealEstateProfile } from "@/types/auth";

export type RealEstateListItem = {
  id: string;
  name: string;
  email: string;
  role: "REAL_ESTATE";
  createdAt: string;
  updatedAt: string;
  applicationsCount: number;
  realEstateProfile?: RealEstateProfile | null;
  wallet?: {
    id: string;
    availableCredits: number;
    isVip: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
};

export async function listRealEstates(search?: string) {
  const response = await api.get<{ realEstates: RealEstateListItem[] }>(
    "/real-estates",
    {
      params: search ? { search } : undefined,
    },
  );

  return response.data.realEstates;
}

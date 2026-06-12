import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const BADGE_DESCRIPTIONS = [
  { id: "perfect_profile", description: "Hoàn thiện hồ sơ cá nhân và giới thiệu bản thân trên hệ thống" },
  { id: "onboarding_warrior", description: "Nhân viên hoàn thành khóa Onboarding đầu tiên" },
  { id: "value_holder", description: "Hoàn thành 2 khóa học Onboarding bất kỳ." },
  { id: "la_ambassador", description: "Hoàn thành khóa Onboarding và 1 khóa học kỹ năng khác" },
  { id: "la_breakthrough", description: "Hoàn thành 3 khóa học khác nhau trên hệ thống" },
  { id: "la_expert", description: "Hoàn thành 5 khóa học khác nhau trên hệ thống" },
  { id: "recruitment_master", description: "Hoàn thành 1 khóa học chuyên sâu về Tuyển Dụng" },
  { id: "otif_expert", description: "Hoàn thành 2 khóa học chuyên sâu về Tuyển Dụng" },
  { id: "trusted_ambassador", description: "Hoàn thành 3 khóa học chuyên sâu về Tuyển Dụng" },
  { id: "omnipotent_master", description: "Hoàn thành 20 khóa học bất kỳ trên hệ thống của L&A" },
  { id: "speed_scholar", description: "Hoàn thành bài giảng với thời gian nhanh kỷ lục trên hệ thống" },
  { id: "system_explorer", description: "Hoàn thành 10 khóa học bất kỳ trên hệ thống" },
];

async function updateDescriptions() {
  const client = await pool.connect();
  try {
    console.log("Updating badge descriptions...");
    for (const badge of BADGE_DESCRIPTIONS) {
      await client.query("UPDATE badge_definitions SET description = $1 WHERE id = $2", [badge.description, badge.id]);
      console.log(`Updated ${badge.id}`);
    }
    console.log("All descriptions updated successfully!");
  } catch (error) {
    console.error("Error updating descriptions:", error);
  } finally {
    client.release();
    pool.end();
  }
}

updateDescriptions();

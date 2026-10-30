-- sql/migrations/001_add_pet_uploads.sql
-- Migration: Add Pet Avatar (photo_url) and Vaccine Certificate (vaccine_card_url) columns to pets

USE pet_hotel;

ALTER TABLE pets
  ADD COLUMN photo_url VARCHAR(255) DEFAULT NULL AFTER medical_notes,
  ADD COLUMN vaccine_card_url VARCHAR(255) DEFAULT NULL AFTER photo_url;

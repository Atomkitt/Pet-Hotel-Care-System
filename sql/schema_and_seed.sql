-- sql/schema_and_seed.sql
-- PawStay Pet Hotel & Care Management System (CSS326 Database Programming Lab)
-- Complete 3NF Schema, Hardened Triggers, Idempotent Stored Procedure, and Initial Seed Data

CREATE DATABASE IF NOT EXISTS pet_hotel
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE pet_hotel;

DROP TRIGGER IF EXISTS trg_after_booking_status_change;
DROP TRIGGER IF EXISTS trg_after_booking_delete;
DROP PROCEDURE IF EXISTS sp_finalize_and_calculate_bill;
DROP TABLE IF EXISTS daily_logs;
DROP TABLE IF EXISTS booking_pets;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS pets;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS users;

-- ============================================================================
-- 1. TABLE DEFINITIONS (6 Tables Normalized to 3NF)
-- ============================================================================

CREATE TABLE users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  role ENUM('User', 'Admin', 'Developer') NOT NULL DEFAULT 'User'
) ENGINE=InnoDB;

CREATE TABLE pets (
  pet_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(50) NOT NULL,
  species ENUM('Dog', 'Cat') NOT NULL,
  breed VARCHAR(50) DEFAULT NULL,
  weight_kg DECIMAL(5,2) NOT NULL,
  behavior_status ENUM('Friendly', 'Aggressive', 'Anxious', 'High-Energy') NOT NULL DEFAULT 'Friendly',
  medical_notes TEXT DEFAULT NULL,
  photo_url VARCHAR(255) DEFAULT NULL,
  vaccine_card_url VARCHAR(255) DEFAULT NULL,
  CONSTRAINT fk_pets_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE rooms (
  room_id INT AUTO_INCREMENT PRIMARY KEY,
  room_number VARCHAR(10) NOT NULL UNIQUE,
  room_type ENUM('Standard', 'Deluxe', 'Suite') NOT NULL,
  max_capacity INT NOT NULL DEFAULT 1,
  base_price_per_night DECIMAL(8,2) NOT NULL,
  status ENUM('Available', 'Occupied', 'Maintenance') NOT NULL DEFAULT 'Available'
) ENGINE=InnoDB;

CREATE TABLE bookings (
  booking_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  room_id INT NOT NULL,
  check_in_date DATETIME NOT NULL,
  check_out_date DATETIME NOT NULL,
  total_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  booking_status ENUM('Pending', 'Confirmed', 'Completed', 'Cancelled') NOT NULL DEFAULT 'Pending',
  payment_status ENUM('Unpaid', 'Pending_Verification', 'Paid') NOT NULL DEFAULT 'Unpaid',
  payment_slip_url VARCHAR(255) DEFAULT NULL,
  CONSTRAINT fk_bookings_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT fk_bookings_room
    FOREIGN KEY (room_id) REFERENCES rooms(room_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE booking_pets (
  booking_pet_id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  pet_id INT NOT NULL,
  has_grooming BOOLEAN NOT NULL DEFAULT FALSE,
  grooming_duration_mins INT NOT NULL DEFAULT 0,
  extra_charge DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  UNIQUE KEY uq_booking_pet (booking_id, pet_id),
  CONSTRAINT fk_booking_pets_booking
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_booking_pets_pet
    FOREIGN KEY (pet_id) REFERENCES pets(pet_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE daily_logs (
  log_id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  pet_id INT NOT NULL,
  log_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activity_type ENUM('Meal', 'Potty', 'Walk', 'Medication', 'General') NOT NULL,
  details VARCHAR(255) NOT NULL,
  CONSTRAINT fk_daily_logs_booking
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_daily_logs_pet
    FOREIGN KEY (pet_id) REFERENCES pets(pet_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 2. DATABASE AUTOMATION (Triggers & Stored Procedure)
-- ============================================================================

DELIMITER $$

CREATE TRIGGER trg_after_booking_status_change
AFTER UPDATE ON bookings
FOR EACH ROW
BEGIN
  DECLARE v_other_confirmed INT DEFAULT 0;

  IF NEW.booking_status = 'Confirmed' THEN
    UPDATE rooms
    SET status = 'Occupied'
    WHERE room_id = NEW.room_id
      AND status != 'Maintenance';
  ELSEIF NEW.booking_status IN ('Completed', 'Cancelled') THEN
    SELECT COUNT(*)
    INTO v_other_confirmed
    FROM bookings
    WHERE room_id = NEW.room_id
      AND booking_status = 'Confirmed'
      AND booking_id != NEW.booking_id;

    IF v_other_confirmed = 0 THEN
      IF OLD.booking_status = 'Confirmed' THEN
        UPDATE rooms
        SET status = 'Available'
        WHERE room_id = NEW.room_id;
      ELSE
        UPDATE rooms
        SET status = 'Available'
        WHERE room_id = NEW.room_id
          AND status != 'Maintenance';
      END IF;
    END IF;
  END IF;
END$$

CREATE TRIGGER trg_after_booking_delete
AFTER DELETE ON bookings
FOR EACH ROW
BEGIN
  DECLARE v_remaining_confirmed INT DEFAULT 0;

  IF OLD.booking_status = 'Confirmed' THEN
    SELECT COUNT(*)
    INTO v_remaining_confirmed
    FROM bookings
    WHERE room_id = OLD.room_id
      AND booking_status = 'Confirmed';

    IF v_remaining_confirmed = 0 THEN
      UPDATE rooms
      SET status = 'Available'
      WHERE room_id = OLD.room_id;
    END IF;
  END IF;
END$$

CREATE PROCEDURE sp_finalize_and_calculate_bill(IN p_booking_id INT)
BEGIN
  DECLARE v_room_id INT DEFAULT NULL;
  DECLARE v_room_number VARCHAR(10) DEFAULT '';
  DECLARE v_room_type VARCHAR(20) DEFAULT '';
  DECLARE v_base_price DECIMAL(8,2) DEFAULT 0.00;
  DECLARE v_check_in DATETIME;
  DECLARE v_check_out DATETIME;
  DECLARE v_current_status VARCHAR(20) DEFAULT '';
  DECLARE v_saved_total DECIMAL(10,2) DEFAULT 0.00;
  DECLARE v_nights INT DEFAULT 1;
  DECLARE v_pet_count INT DEFAULT 0;
  DECLARE v_guest_pets VARCHAR(255) DEFAULT '';
  DECLARE v_lodging_charge DECIMAL(10,2) DEFAULT 0.00;
  DECLARE v_multi_pet_surcharge DECIMAL(10,2) DEFAULT 0.00;
  DECLARE v_grooming_fee DECIMAL(10,2) DEFAULT 0.00;
  DECLARE v_final_total DECIMAL(10,2) DEFAULT 0.00;

  SELECT b.room_id, r.room_number, r.room_type, r.base_price_per_night, b.check_in_date, b.check_out_date, b.booking_status, b.total_price
  INTO v_room_id, v_room_number, v_room_type, v_base_price, v_check_in, v_check_out, v_current_status, v_saved_total
  FROM bookings b
  JOIN rooms r ON b.room_id = r.room_id
  WHERE b.booking_id = p_booking_id
  FOR UPDATE;

  IF v_room_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Booking not found for sp_finalize_and_calculate_bill';
  END IF;

  IF v_current_status = 'Cancelled' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Cannot finalize bill for a Cancelled booking';
  END IF;

  IF v_current_status = 'Pending' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Cannot checkout a Pending booking prior to check-in confirmation';
  END IF;

  SET v_nights = DATEDIFF(v_check_out, v_check_in);
  IF v_nights < 1 THEN
    SET v_nights = 1;
  END IF;

  IF v_current_status = 'Completed' THEN
    SELECT
      COUNT(bp.pet_id),
      COALESCE(GROUP_CONCAT(p.name ORDER BY bp.booking_pet_id SEPARATOR ' & '), 'N/A'),
      COALESCE(SUM(bp.extra_charge), 0.00)
    INTO v_pet_count, v_guest_pets, v_grooming_fee
    FROM booking_pets bp
    JOIN pets p ON bp.pet_id = p.pet_id
    WHERE bp.booking_id = p_booking_id;

    IF v_pet_count > 1 THEN
      SET v_multi_pet_surcharge = (v_pet_count - 1) * 300.00 * v_nights;
    ELSE
      SET v_multi_pet_surcharge = 0.00;
    END IF;

    SET v_final_total = v_saved_total;
    SET v_lodging_charge = GREATEST(0.00, v_final_total - v_multi_pet_surcharge - v_grooming_fee);
  ELSE
    SET v_lodging_charge = v_nights * v_base_price;

    SELECT
      COUNT(bp.pet_id),
      COALESCE(GROUP_CONCAT(p.name ORDER BY bp.booking_pet_id SEPARATOR ' & '), 'N/A'),
      COALESCE(SUM(
        CASE
          WHEN bp.has_grooming = TRUE THEN
            CASE
              WHEN p.weight_kg < 8 THEN 500.00
              WHEN p.weight_kg BETWEEN 8 AND 20 THEN 800.00
              ELSE 1200.00
            END
          ELSE 0.00
        END
      ), 0.00)
    INTO v_pet_count, v_guest_pets, v_grooming_fee
    FROM booking_pets bp
    JOIN pets p ON bp.pet_id = p.pet_id
    WHERE bp.booking_id = p_booking_id;

    UPDATE booking_pets bp
    JOIN pets p ON bp.pet_id = p.pet_id
    SET bp.extra_charge = CASE
      WHEN bp.has_grooming = TRUE THEN
        CASE
          WHEN p.weight_kg < 8 THEN 500.00
          WHEN p.weight_kg BETWEEN 8 AND 20 THEN 800.00
          ELSE 1200.00
        END
      ELSE 0.00
    END
    WHERE bp.booking_id = p_booking_id;

    IF v_pet_count > 1 THEN
      SET v_multi_pet_surcharge = (v_pet_count - 1) * 300.00 * v_nights;
    ELSE
      SET v_multi_pet_surcharge = 0.00;
    END IF;

    SET v_final_total = v_lodging_charge + v_multi_pet_surcharge + v_grooming_fee;

    UPDATE bookings
    SET total_price = v_final_total,
        booking_status = 'Completed',
        payment_status = 'Paid'
    WHERE booking_id = p_booking_id;
  END IF;

  SELECT
    p_booking_id AS booking_id,
    v_room_number AS room_number,
    v_room_type AS room_type,
    v_guest_pets AS guest_pets,
    v_nights AS stay_nights,
    v_pet_count AS pet_count,
    v_lodging_charge AS lodging_charge,
    v_multi_pet_surcharge AS multi_pet_surcharge,
    v_grooming_fee AS grooming_fee,
    v_final_total AS total_price,
    'Completed' AS booking_status;
END$$

DELIMITER ;

-- ============================================================================
-- 3. INITIAL SEED DATA
-- ============================================================================

-- Default Accounts (All demo passwords hashed via bcrypt with 10 salt rounds; plaintext: "test1234")
INSERT INTO users (name, email, password_hash, phone, role) VALUES
  ('Kittiphat Khumsawad', 'atomkittiphat@gmail.com', '$2b$10$/61BLOvtTRxhtybArEuhUOgHZn962jTh1tPf6XD9vTlQHuFGZ/BzO', '081-234-5678', 'User'),
  ('Staff Desk #01', 'staff01@pawstay.local', '$2b$10$LKGZtfGGM0BeXmImX0zgmuiYpBzHjNf86UHWinYM7AkmVVqHrPqrC', '082-345-6789', 'Admin'),
  ('Nattapat Ungphakorn', 'nattapat@pawstay.dev', '$2b$10$FOjAiFyGEnc/sLJoQGb/GeFKJRIMRzQdn1BTQ82V8OSyIx3L2UaQO', '083-456-7890', 'Developer'),
  ('David Miller', 'david.miller@example.com', '$2b$10$KlNGCpa0jck3/FcAGic8jubfvDjwKNz3dFe6Zxxhza3tlDKv/waJO', '084-567-8901', 'User');

-- Hotel Suites (Standard, Deluxe, Suite/VIP)
INSERT INTO rooms (room_number, room_type, max_capacity, base_price_per_night, status) VALUES
  ('101', 'Deluxe', 3, 1000.00, 'Available'),
  ('102', 'Suite', 4, 1800.00, 'Available'),
  ('103', 'Standard', 2, 600.00, 'Available'),
  ('104', 'Deluxe', 3, 1000.00, 'Maintenance');

-- Registered Pets (Vaccine certificates stored in protected storage, served via authenticated API)
INSERT INTO pets (user_id, name, species, breed, weight_kg, behavior_status, medical_notes, photo_url, vaccine_card_url) VALUES
  (1, 'Milo', 'Dog', 'Golden Retriever', 28.50, 'Friendly', 'Vaccinated. Loves outdoor fetch sessions.', NULL, 'sample-vaccine-milo.png'),
  (1, 'Luna', 'Cat', 'Siamese Cat', 4.20, 'Anxious', 'Sensitive to loud barking; prefers quiet corner.', NULL, NULL),
  (4, 'Buster', 'Dog', 'German Shepherd', 32.00, 'Aggressive', 'Do not release into a shared yard with other dogs.', NULL, 'sample-vaccine-buster.png');

-- Sample Bookings (Dynamic current dates: 3 nights for Booking #1 = 5100.00 THB, 2 nights for Booking #2 = 4800.00 THB)
INSERT INTO bookings (user_id, room_id, check_in_date, check_out_date, total_price, booking_status, payment_status) VALUES
  (1, 1, CONCAT(CURDATE(), ' 14:00:00'), CONCAT(DATE_ADD(CURDATE(), INTERVAL 3 DAY), ' 12:00:00'), 5100.00, 'Pending', 'Paid'),
  (4, 2, CONCAT(DATE_SUB(CURDATE(), INTERVAL 1 DAY), ' 14:00:00'), CONCAT(DATE_ADD(CURDATE(), INTERVAL 1 DAY), ' 12:00:00'), 4800.00, 'Pending', 'Paid');

-- Multi-Pet Allocations & Grooming Add-ons
INSERT INTO booking_pets (booking_id, pet_id, has_grooming, grooming_duration_mins, extra_charge) VALUES
  (1, 1, TRUE, 60, 1200.00),
  (1, 2, FALSE, 0, 0.00),
  (2, 3, TRUE, 60, 1200.00);

-- Confirm active stays (Automatically fires trg_after_booking_status_change -> marks Rooms 101 & 102 Occupied)
UPDATE bookings
SET booking_status = 'Confirmed'
WHERE booking_id IN (1, 2);

-- Sample Daily Care Logs
INSERT INTO daily_logs (booking_id, pet_id, log_time, activity_type, details) VALUES
  (1, 1, CONCAT(CURDATE(), ' 08:30:00'), 'Meal', 'Breakfast Served: Milo and Luna both finished their meals completely.'),
  (1, 2, CONCAT(CURDATE(), ' 09:00:00'), 'Meal', 'Luna finished wet cat food portion quietly in elevated corner.'),
  (1, 1, CONCAT(CURDATE(), ' 11:15:00'), 'Walk', 'Outdoor Play Session: Milo enjoyed a 30-minute fetch session in the yard.'),
  (1, 1, CONCAT(CURDATE(), ' 14:00:00'), 'General', 'Grooming Completed: Full coat wash, blow-dry, and nail trimming finished.'),
  (2, 3, CONCAT(CURDATE(), ' 09:30:00'), 'Walk', 'Solo leashed walk completed safely in isolated paddock.');

-- sql/migrations/002_security_and_logic_hardening.sql
-- Migration 002: Payment verification columns + Hardened Triggers + Idempotent/State-guarded Stored Procedure

USE pet_hotel;

ALTER TABLE bookings
  ADD COLUMN payment_status ENUM('Unpaid', 'Pending_Verification', 'Paid') NOT NULL DEFAULT 'Unpaid' AFTER booking_status,
  ADD COLUMN payment_slip_url VARCHAR(255) DEFAULT NULL AFTER payment_status;

UPDATE bookings
SET payment_status = 'Paid'
WHERE booking_status IN ('Confirmed', 'Completed');

DROP TRIGGER IF EXISTS trg_after_booking_status_change;
DROP TRIGGER IF EXISTS trg_after_booking_delete;
DROP PROCEDURE IF EXISTS sp_finalize_and_calculate_bill;

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

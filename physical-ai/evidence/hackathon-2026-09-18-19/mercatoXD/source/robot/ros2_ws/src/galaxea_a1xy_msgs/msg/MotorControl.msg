# Mirrors hdas_msg/MotorControl from the Galaxea SDK.
# Arrays are per-joint (6 for the A1X arm).
std_msgs/Header header
string name
float32[] p_des   # rad,   clamped +/-6.5
float32[] v_des   # rad/s, clamped +/-40
float32[] kp      # 0..500
float32[] kd      # 0..200
float32[] t_ff    # +/-50
uint8 mode
